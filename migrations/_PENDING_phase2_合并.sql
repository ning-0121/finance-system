-- ============================================================
-- Phase 2 待执行迁移合并包（按顺序，全部幂等可重复执行）
-- 在 Supabase SQL Editor 一次性粘贴执行即可。
-- 含：汇率主数据 / 可信度巡检 / 异常中心认领 / 银行流水 / 月结快照 / 工资条
-- ============================================================


-- ========== 20260611_exchange_rates_master.sql ==========

-- ============================================================
-- Phase 2 #2b：汇率主数据表
-- 结构与现有消费方 /api/profit/fx 的查询完全对齐
-- （base_currency / quote_currency / rate / fetched_at），建表即激活该接口。
-- 用途：全系统统一汇率来源，逐步替换散落的 ||7 / 7.1 / 7.15 / 7.24 写死值；
--       期末汇兑重估改为取本表最新汇率，取不到则拒绝生成草稿（绝不臆造汇率入 GL）。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency  text NOT NULL DEFAULT 'USD',
  quote_currency text NOT NULL DEFAULT 'CNY',
  rate numeric(10,4) NOT NULL CHECK (rate > 0),
  rate_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Shanghai')::date),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','bank','api')),
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_currency, quote_currency, rate_date)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup
  ON public.exchange_rates (base_currency, quote_currency, fetched_at DESC);

-- RLS：登录可读；财务角色可写（与核心表同口径）
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exchange_rates_read       ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_insert_fin ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_update_fin ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_delete_mgr ON public.exchange_rates;
CREATE POLICY exchange_rates_read ON public.exchange_rates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY exchange_rates_insert_fin ON public.exchange_rates
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY exchange_rates_update_fin ON public.exchange_rates
  FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY exchange_rates_delete_mgr ON public.exchange_rates
  FOR DELETE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- 录入今日汇率示例（财务在 SQL Editor 或后续界面执行）：
-- INSERT INTO public.exchange_rates (base_currency, quote_currency, rate, source, notes)
-- VALUES ('USD','CNY', 7.2400, 'manual', '中行中间价');

-- 验证：
-- SELECT * FROM public.exchange_rates ORDER BY fetched_at DESC LIMIT 5;

-- ========== 20260611_integrity_runs.sql ==========

-- ============================================================
-- Phase 2 #3：财务可信度中心 — 巡检结果表
-- 每次巡检（每日 cron / 手动）一行：总分 + 分维度得分 + 检查明细 jsonb。
-- 异常明细落 audit_findings（复用既有三级分级与处理流）。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.integrity_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('cron','manual','closing')),
  score numeric(5,2) NOT NULL,                -- 总评分 0-100
  dimension_scores jsonb NOT NULL DEFAULT '{}'::jsonb, -- {completeness, consistency, uniqueness, timeliness}
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,           -- 总量卡：各单据数量
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,           -- 检查明细 [{key,label,status,severity,detail,count,varianceCny}]
  critical_count int NOT NULL DEFAULT 0,
  warning_count int NOT NULL DEFAULT 0,
  info_count int NOT NULL DEFAULT 0,
  summary_text text,
  created_by uuid REFERENCES public.profiles(id),      -- 手动触发人；cron 为 null
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrity_runs_at ON public.integrity_runs (run_at DESC);

ALTER TABLE public.integrity_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integrity_runs_read  ON public.integrity_runs;
DROP POLICY IF EXISTS integrity_runs_write ON public.integrity_runs;
CREATE POLICY integrity_runs_read ON public.integrity_runs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY integrity_runs_write ON public.integrity_runs
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));

-- 验证：
-- SELECT count(*) FROM public.integrity_runs;

-- ========== 20260612_exception_center_workflow.sql ==========

-- ============================================================
-- Phase 2 #4：异常中心 — audit_findings 处理闭环字段
-- 复用现有 audit_findings（已有 status open/investigating/resolved/dismissed
-- + resolved_by/resolved_at/resolution_note）。仅补「认领」字段。
-- 可加可逆，回滚见 .down.sql
-- ============================================================
ALTER TABLE public.audit_findings ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.profiles(id);
ALTER TABLE public.audit_findings ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- 按状态+严重度筛选的复合索引（异常中心列表主查询路径）
CREATE INDEX IF NOT EXISTS idx_audit_findings_status_sev
  ON public.audit_findings (status, severity, created_at DESC);

-- 验证：
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='audit_findings' AND column_name IN ('assigned_to','assigned_at');

-- ========== 20260612_bank_transactions.sql ==========

-- ============================================================
-- Phase 2 #5：银行流水 + 对账
-- 给"现金"上锚：导入银行对账单流水，与系统回款/付款逐笔对账。
-- 幂等导入：dedup_key 唯一约束（账户+日期+方向+金额+对手+摘要+流水号的指纹），
--          ON CONFLICT DO NOTHING，同一份对账单重复导入不会产生重复行。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id),
  txn_date date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in','out')),   -- in=收/借方  out=付/贷方
  amount numeric(15,2) NOT NULL CHECK (amount >= 0),           -- 恒正，方向由 direction 表示
  currency text NOT NULL DEFAULT 'CNY',
  balance_after numeric(15,2),                                 -- 对账单上的余额（可空）
  counterparty text,                                           -- 对方户名
  summary text,                                                -- 摘要/用途
  reference text,                                              -- 银行交易流水号
  -- 对账状态
  match_status text NOT NULL DEFAULT 'unmatched' CHECK (match_status IN ('unmatched','matched','ignored')),
  matched_type text CHECK (matched_type IN ('receivable_payment','supplier_payment','manual')),
  matched_id uuid,                                             -- 指向回款流水/付款流水（弱引用，不设FK跨表）
  match_note text,
  matched_by uuid REFERENCES public.profiles(id),
  matched_at timestamptz,
  -- 导入溯源
  import_batch text,
  dedup_key text NOT NULL,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_bank_txn_account_date ON public.bank_transactions (bank_account_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_match ON public.bank_transactions (match_status, direction);

-- RLS：登录可读；财务可写；主管可删（与核心表同口径）
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bank_txn_read       ON public.bank_transactions;
DROP POLICY IF EXISTS bank_txn_insert_fin ON public.bank_transactions;
DROP POLICY IF EXISTS bank_txn_update_fin ON public.bank_transactions;
DROP POLICY IF EXISTS bank_txn_delete_mgr ON public.bank_transactions;
CREATE POLICY bank_txn_read ON public.bank_transactions
  FOR SELECT TO authenticated USING (true);
CREATE POLICY bank_txn_insert_fin ON public.bank_transactions
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY bank_txn_update_fin ON public.bank_transactions
  FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY bank_txn_delete_mgr ON public.bank_transactions
  FOR DELETE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- 验证：
-- SELECT count(*) FROM public.bank_transactions;

-- ========== 20260613_month_end_closing.sql ==========

-- ============================================================
-- Phase 2 #6：月结中心增强
-- ① month_end_snapshots：锁账时固化月度经营数字（锁账产物，老板月报数据源）
-- ② accounting_periods 增解锁审批字段（财务经理发起 → admin 批准）
-- 可加可逆，回滚见 .down.sql
-- ============================================================

-- ① 月结快照
CREATE TABLE IF NOT EXISTS public.month_end_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code text NOT NULL UNIQUE,
  panel jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 订单数/已决算/收入/成本/利润/毛利率/应收/应付/回款率 等
  closed_by uuid REFERENCES public.profiles(id),
  closed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.month_end_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS month_end_read       ON public.month_end_snapshots;
DROP POLICY IF EXISTS month_end_write_fin  ON public.month_end_snapshots;
CREATE POLICY month_end_read ON public.month_end_snapshots
  FOR SELECT TO authenticated USING (true);
CREATE POLICY month_end_write_fin ON public.month_end_snapshots
  FOR ALL TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- ② 解锁审批字段
ALTER TABLE public.accounting_periods ADD COLUMN IF NOT EXISTS reopen_requested_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.accounting_periods ADD COLUMN IF NOT EXISTS reopen_requested_at timestamptz;
ALTER TABLE public.accounting_periods ADD COLUMN IF NOT EXISTS reopen_reason text;

-- 验证：
-- SELECT count(*) FROM public.month_end_snapshots;
-- SELECT column_name FROM information_schema.columns WHERE table_name='accounting_periods' AND column_name LIKE 'reopen%';

-- ========== 20260613_payroll.sql ==========

-- ============================================================
-- 工资条发放（导入算好的工资表 → 生成工资条 → 企业微信私发）
-- 不含工资计算（社保/个税引擎）。薪资数据敏感：
--   payroll_batches/payroll_slips 仅 finance_manager + admin 可读写（财务员看不到）。
--   employees 花名册：登录可读（姓名/部门非密），财务经理/管理员可写。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

-- ① 员工花名册（企业微信通讯录同步进来，提供 wecom_userid 作工资条收件人）
CREATE TABLE IF NOT EXISTS public.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  wecom_userid text UNIQUE,          -- 企业微信成员ID，工资条 touser
  department text,
  email text,
  mobile text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employees_name ON public.employees (name);

-- ② 工资批次（一个发薪期一批）
CREATE TABLE IF NOT EXISTS public.payroll_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code text NOT NULL,         -- 如 2026-06
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  slip_count int NOT NULL DEFAULT 0,
  sent_count int NOT NULL DEFAULT 0,
  total_net numeric(15,2) NOT NULL DEFAULT 0,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ③ 工资条（每人一条）
CREATE TABLE IF NOT EXISTS public.payroll_slips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.payroll_batches(id) ON DELETE CASCADE,
  employee_name text NOT NULL,
  wecom_userid text,                 -- 匹配花名册得到；空=无法私发
  net_pay numeric(15,2) NOT NULL DEFAULT 0,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{label, amount}] 工资条各项（应发项+扣减项）
  send_status text NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending','sent','failed','skipped')),
  sent_at timestamptz,
  send_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_slips_batch ON public.payroll_slips (batch_id);

-- RLS
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employees_read ON public.employees;
DROP POLICY IF EXISTS employees_write ON public.employees;
CREATE POLICY employees_read ON public.employees FOR SELECT TO authenticated USING (true);
CREATE POLICY employees_write ON public.employees FOR ALL TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

ALTER TABLE public.payroll_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_batches_all ON public.payroll_batches;
CREATE POLICY payroll_batches_all ON public.payroll_batches FOR ALL TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

ALTER TABLE public.payroll_slips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_slips_all ON public.payroll_slips;
CREATE POLICY payroll_slips_all ON public.payroll_slips FOR ALL TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- 验证：
-- SELECT count(*) FROM public.employees;
-- SELECT column_name FROM information_schema.columns WHERE table_name='payroll_slips';
