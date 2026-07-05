-- ============================================================
-- 周排款(排款单)子系统 · 结构层
--
-- 背景：付款此前有两条互不相通的「出款」路径 —— 应付 payable_records(有状态机)
--   与 对账单 supplier_payments(可直接手记)。同一笔钱能在两处各记一次 → 重复付款。
-- 目标：把出款收敛成唯一通道 —— 应付明细 → 周排款单 → 老板审批 → 出纳执行(唯一
--   出口,原子写实付+推进应付) → 对账单自动同步。本迁移只建「结构」,RPC 见下一支。
--
-- 业务口径(老板已确认 2026-07-05)：
--   · 支持一笔应付分多次付(定金+尾款/跨周部分付) → 锁按「剩余可付」,不锁「一次付清」
--   · 两步审批：财务排款(draft→submitted) → 老板审批放款(approved)
--   · 每张排款单单一币种(USD 单独排、CNY 单独排)
--
-- 防重复付款(结构性,不靠人自觉)：
--   ① 应付是唯一真相,带 paid_amount(累计已付)；剩余 = amount - paid_amount
--   ② 加入排款单时 RPC 行锁校验 Σ(未关闭行 pay_amount)+paid_amount ≤ amount → 不能重复排
--   ③ 执行付款原子 RPC：写实付 + 涨 paid_amount + 推状态,executed_at 幂等 → 不能执行两次
--   ④ supplier_payments.source_batch_line_id 唯一 → 一行只能生成一笔实付(幂等兜底)
--   ⑤ 凭证号 (supplier_name, payment_ref) 唯一(20260705 已加) → 最后兜底
--
-- 加法式、可空/带默认、幂等；回滚见 .down.sql。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. 周排款单表头 payment_batches
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no          text NOT NULL,                    -- 单号 PR-YYYYMMDD-CCY-NN (RPC 生成)
  title             text,                             -- 备注标题,如「第28周排款」
  currency          text NOT NULL,                    -- 单一币种(CNY/USD/...)
  week_label        text,                             -- 周标签 2026-W28(便于按周汇总)
  planned_pay_date  date,                             -- 计划放款日
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','submitted','approved','executing','closed','cancelled')),
  total_amount      numeric(15,2) NOT NULL DEFAULT 0, -- 计划付款总额(该币种,=Σ未关闭行)
  paid_total        numeric(15,2) NOT NULL DEFAULT 0, -- 已执行付款累计(该币种)
  notes             text,
  created_by        uuid REFERENCES public.profiles(id),
  submitted_by      uuid REFERENCES public.profiles(id),
  submitted_at      timestamptz,
  approved_by       uuid REFERENCES public.profiles(id),  -- 老板
  approved_at       timestamptz,
  closed_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  deleted_by        uuid REFERENCES public.profiles(id),
  delete_reason     text
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_batches_batch_no_uniq
  ON public.payment_batches (batch_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_batches_status ON public.payment_batches (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payment_batches_week   ON public.payment_batches (week_label) WHERE deleted_at IS NULL;

COMMENT ON TABLE public.payment_batches IS '周排款单表头：单一币种,两步审批(财务提交→老板放款),status 状态机。';

-- ─────────────────────────────────────────────────────────────
-- 2. 排款明细行 payment_batch_lines(一行 = 对一笔应付计划付多少)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_batch_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES public.payment_batches(id),
  payable_id    uuid NOT NULL REFERENCES public.payable_records(id),
  supplier_name text NOT NULL,                       -- 冗余(显示/核对)
  pay_amount    numeric(15,2) NOT NULL CHECK (pay_amount > 0), -- 本行计划付款额(可 < 应付剩余 = 部分付)
  currency      text NOT NULL,                        -- 必须 == batch.currency(RPC 保证)
  -- 收款信息快照(排款当时,防应付后续被改)
  payee_name    text,
  payee_account text,
  payee_bank    text,
  status        text NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned','paid','skipped','held')),
  -- 执行结果
  payment_id    uuid REFERENCES public.supplier_payments(id),  -- 执行后指向实付流水
  payment_ref   text,                                 -- 凭证号(执行时录,复制到 supplier_payments)
  executed_at   timestamptz,
  executed_by   uuid REFERENCES public.profiles(id),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES public.profiles(id),
  delete_reason text
);

CREATE INDEX IF NOT EXISTS idx_batch_lines_batch    ON public.payment_batch_lines (batch_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_batch_lines_payable  ON public.payment_batch_lines (payable_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_batch_lines_status   ON public.payment_batch_lines (status) WHERE deleted_at IS NULL;

COMMENT ON TABLE public.payment_batch_lines IS '排款明细行：对一笔应付计划付 pay_amount(可部分)。防重靠 RPC 行锁 Σ≤应付额 + 执行幂等。';

-- ─────────────────────────────────────────────────────────────
-- 3. supplier_payments 增 source_batch_line_id → 排款执行幂等(一行一笔实付)
--    (source_payable_id 唯一无法支持部分付的多笔,故排款路径改用 line_id)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.supplier_payments
  ADD COLUMN IF NOT EXISTS source_batch_line_id uuid REFERENCES public.payment_batch_lines(id);

CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_batch_line_uniq
  ON public.supplier_payments (source_batch_line_id)
  WHERE source_batch_line_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN public.supplier_payments.source_batch_line_id IS '排款执行来源行,唯一 → 同一排款行不可重复生成实付(防重复付款幂等键)。';

-- ─────────────────────────────────────────────────────────────
-- 4. payable_records 状态机增 'partially_paid'(部分付,余额可下周再排)
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE c record;
BEGIN
  -- 按定义查出治理 payment_status 的所有 CHECK 约束并 drop(不假设名称)
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'public.payable_records'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%payment_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.payable_records DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.payable_records ADD CONSTRAINT payable_records_payment_status_check
    CHECK (payment_status IN ('unpaid','pending_approval','approved','partially_paid','paid','cancelled'));
END $$;

-- 保证 paid_amount 有默认 0(累计已付基准；历史 NULL 视为未付)
ALTER TABLE public.payable_records ALTER COLUMN paid_amount SET DEFAULT 0;
UPDATE public.payable_records SET paid_amount = 0 WHERE paid_amount IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 5. updated_at 触发器(复用 update_updated_at)
-- ─────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS update_payment_batches_ts ON public.payment_batches;
CREATE TRIGGER update_payment_batches_ts BEFORE UPDATE ON public.payment_batches
  FOR EACH ROW EXECUTE PROCEDURE public.update_updated_at();
DROP TRIGGER IF EXISTS update_payment_batch_lines_ts ON public.payment_batch_lines;
CREATE TRIGGER update_payment_batch_lines_ts BEFORE UPDATE ON public.payment_batch_lines
  FOR EACH ROW EXECUTE PROCEDURE public.update_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 6. 硬删除防护(复用 financial_hard_delete_guard)+ 扩 _admin_hard_delete 白名单
-- ─────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_no_hard_delete ON public.payment_batches;
CREATE TRIGGER trg_no_hard_delete BEFORE DELETE ON public.payment_batches
  FOR EACH ROW EXECUTE FUNCTION public.financial_hard_delete_guard();
DROP TRIGGER IF EXISTS trg_no_hard_delete ON public.payment_batch_lines;
CREATE TRIGGER trg_no_hard_delete BEFORE DELETE ON public.payment_batch_lines
  FOR EACH ROW EXECUTE FUNCTION public.financial_hard_delete_guard();

CREATE OR REPLACE FUNCTION public._admin_hard_delete(
  p_table text, p_id uuid, p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_allowed text[] := ARRAY[
    'actual_invoices','payable_records','order_settlements','budget_orders',
    'shipping_documents','financial_risk_events','cost_items',
    'journal_entries','journal_lines',
    'supplier_payments','payment_batches','payment_batch_lines'
  ];
BEGIN
  IF NOT (p_table = ANY(v_allowed)) THEN
    RAISE EXCEPTION '_admin_hard_delete: 表 % 不在受保护清单内（不需要此 RPC）', p_table;
  END IF;
  PERFORM set_config('financial.allow_hard_delete', 'on', true);
  EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_table) USING p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('table', p_table, 'id', p_id, 'deleted_rows', v_count,
    'reason', p_reason, 'executed_at', now());
END $$;
REVOKE ALL ON FUNCTION public._admin_hard_delete(text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 7. RLS：读=登录；写=财务角色；删=财务主管/管理员(同其他财务表)
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE t text; tables text[] := ARRAY['payment_batches','payment_batch_lines'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert_fin', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update_fin', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_mgr', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin''))', t || '_insert_fin', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin'')) WITH CHECK (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin''))', t || '_update_fin', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (coalesce(public._app_role(), ''none'') IN (''finance_manager'',''admin''))', t || '_delete_mgr', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 8. 自验证
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE v int;
BEGIN
  IF to_regclass('public.payment_batches') IS NULL THEN RAISE EXCEPTION '缺表 payment_batches'; END IF;
  IF to_regclass('public.payment_batch_lines') IS NULL THEN RAISE EXCEPTION '缺表 payment_batch_lines'; END IF;
  SELECT count(*) INTO v FROM information_schema.columns
    WHERE table_name='supplier_payments' AND column_name='source_batch_line_id';
  IF v < 1 THEN RAISE EXCEPTION 'supplier_payments 缺列 source_batch_line_id'; END IF;
  SELECT count(*) INTO v FROM pg_trigger WHERE tgname='trg_no_hard_delete'
    AND tgrelid IN ('public.payment_batches'::regclass,'public.payment_batch_lines'::regclass);
  IF v < 2 THEN RAISE EXCEPTION '排款表缺硬删除防护触发器 (count=%)', v; END IF;
  RAISE NOTICE '✓ 周排款子系统结构层已就绪(payment_batches + payment_batch_lines + 幂等键 + 防护 + RLS)';
END $$;
