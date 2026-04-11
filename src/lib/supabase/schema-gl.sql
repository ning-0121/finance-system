-- ============================================================
-- Phase 2: 会计基础设施 — 科目表 + 记账凭证 + 总账 + 会计期间
-- 对标金蝶/用友的GL模块
-- ============================================================

-- ========== 1. 科目表 (Chart of Accounts) ==========

CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_code text NOT NULL UNIQUE,        -- 如 1001, 2201, 5001
  account_name text NOT NULL,               -- 如 银行存款, 应付账款
  account_type text NOT NULL CHECK (account_type IN (
    'asset',      -- 资产
    'liability',  -- 负债
    'equity',     -- 所有者权益
    'revenue',    -- 收入
    'expense'     -- 费用/成本
  )),
  parent_code text,                         -- 上级科目代码（树形结构）
  level integer NOT NULL DEFAULT 1,         -- 科目层级 1=一级 2=二级 3=三级
  currency text DEFAULT 'CNY',              -- 核算币种
  is_active boolean DEFAULT true,           -- 是否启用
  is_detail boolean DEFAULT true,           -- 是否明细科目（可记账）
  balance_direction text DEFAULT 'debit' CHECK (balance_direction IN ('debit', 'credit')),
  description text,
  created_at timestamptz DEFAULT now()
);

-- 预置外贸服装行业科目
INSERT INTO public.accounts (account_code, account_name, account_type, level, balance_direction, is_detail, description) VALUES
-- 资产类
('1001', '库存现金', 'asset', 1, 'debit', true, '人民币现金'),
('1002', '银行存款', 'asset', 1, 'debit', false, '银行账户'),
('100201', '银行存款-人民币', 'asset', 2, 'debit', true, '人民币银行账户'),
('100202', '银行存款-美元', 'asset', 2, 'debit', true, '美元银行账户'),
('1122', '应收账款', 'asset', 1, 'debit', true, '客户应收款'),
('1123', '预付账款', 'asset', 1, 'debit', true, '预付供应商款'),
('1131', '应收外汇', 'asset', 1, 'debit', true, '待结汇外汇'),
('1221', '其他应收款', 'asset', 1, 'debit', true, '其他应收'),
('1401', '原材料', 'asset', 1, 'debit', false, '面料辅料等'),
('140101', '原材料-面料', 'asset', 2, 'debit', true, '面料采购'),
('140102', '原材料-辅料', 'asset', 2, 'debit', true, '辅料采购'),
('1405', '库存商品', 'asset', 1, 'debit', true, '成品库存'),
-- 负债类
('2202', '应付账款', 'liability', 1, 'credit', true, '供应商应付款'),
('2203', '预收账款', 'liability', 1, 'credit', true, '客户预收定金'),
('2211', '应付职工薪酬', 'liability', 1, 'credit', true, '工资社保'),
('2221', '应交税费', 'liability', 1, 'credit', false, '增值税/所得税'),
('222101', '应交税费-增值税', 'liability', 2, 'credit', true, '增值税'),
('222102', '应交税费-出口退税', 'liability', 2, 'credit', true, '出口退税'),
('2241', '其他应付款', 'liability', 1, 'credit', true, '其他应付'),
-- 所有者权益
('3001', '实收资本', 'equity', 1, 'credit', true, '注册资本'),
('3101', '本年利润', 'equity', 1, 'credit', true, '本年利润'),
('3103', '未分配利润', 'equity', 1, 'credit', true, '累计未分配利润'),
-- 收入类
('5001', '主营业务收入', 'revenue', 1, 'credit', false, '服装出口收入'),
('500101', '主营业务收入-外销', 'revenue', 2, 'credit', true, '外销收入'),
('500102', '主营业务收入-内销', 'revenue', 2, 'credit', true, '内销收入'),
('5051', '其他业务收入', 'revenue', 1, 'credit', true, '其他收入'),
('5301', '汇兑收益', 'revenue', 1, 'credit', true, '结汇汇兑损益'),
-- 成本/费用类
('5401', '主营业务成本', 'expense', 1, 'debit', false, '服装生产成本'),
('540101', '主营业务成本-面料', 'expense', 2, 'debit', true, '面料成本'),
('540102', '主营业务成本-辅料', 'expense', 2, 'debit', true, '辅料成本'),
('540103', '主营业务成本-加工费', 'expense', 2, 'debit', true, '加工成本'),
('5402', '销售费用', 'expense', 1, 'debit', false, '销售相关费用'),
('540201', '销售费用-货代费', 'expense', 2, 'debit', true, '货代运输费'),
('540202', '销售费用-装柜费', 'expense', 2, 'debit', true, '装柜费用'),
('540203', '销售费用-物流费', 'expense', 2, 'debit', true, '物流费用'),
('540204', '销售费用-佣金', 'expense', 2, 'debit', true, '销售佣金'),
('540205', '销售费用-报关费', 'expense', 2, 'debit', true, '报关费用'),
('5403', '管理费用', 'expense', 1, 'debit', true, '管理费用'),
('5601', '汇兑损失', 'expense', 1, 'debit', true, '结汇汇兑损失')
ON CONFLICT (account_code) DO NOTHING;


-- ========== 2. 会计期间 (Accounting Periods) ==========

CREATE TABLE IF NOT EXISTS public.accounting_periods (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  period_code text NOT NULL UNIQUE,         -- 如 2026-04
  year integer NOT NULL,
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed')),
  closed_by uuid REFERENCES public.profiles(id),
  closed_at timestamptz,
  close_notes text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(year, month)
);

-- 预生成2026年会计期间
INSERT INTO public.accounting_periods (period_code, year, month, start_date, end_date) VALUES
('2026-01', 2026, 1, '2026-01-01', '2026-01-31'),
('2026-02', 2026, 2, '2026-02-01', '2026-02-28'),
('2026-03', 2026, 3, '2026-03-01', '2026-03-31'),
('2026-04', 2026, 4, '2026-04-01', '2026-04-30'),
('2026-05', 2026, 5, '2026-05-01', '2026-05-31'),
('2026-06', 2026, 6, '2026-06-01', '2026-06-30'),
('2026-07', 2026, 7, '2026-07-01', '2026-07-31'),
('2026-08', 2026, 8, '2026-08-01', '2026-08-31'),
('2026-09', 2026, 9, '2026-09-01', '2026-09-30'),
('2026-10', 2026, 10, '2026-10-01', '2026-10-31'),
('2026-11', 2026, 11, '2026-11-01', '2026-11-30'),
('2026-12', 2026, 12, '2026-12-01', '2026-12-31')
ON CONFLICT (period_code) DO NOTHING;


-- ========== 3. 记账凭证 (Journal Entries) ==========

CREATE TABLE IF NOT EXISTS public.journal_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  voucher_no text NOT NULL UNIQUE,          -- 凭证号 如 PZ-202604-0001
  period_code text NOT NULL REFERENCES public.accounting_periods(period_code),
  voucher_date date NOT NULL,
  voucher_type text NOT NULL DEFAULT 'auto' CHECK (voucher_type IN (
    'auto',     -- 系统自动生成
    'manual',   -- 手工录入
    'closing'   -- 期末结转
  )),
  description text NOT NULL,                -- 摘要
  source_type text,                         -- 来源类型: budget_order, settlement, payment, receipt
  source_id uuid,                           -- 来源单据ID
  total_debit numeric(15,2) NOT NULL DEFAULT 0,
  total_credit numeric(15,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'voided')),
  created_by uuid REFERENCES public.profiles(id),
  posted_by uuid REFERENCES public.profiles(id),
  posted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  -- 借贷必须平衡
  CONSTRAINT chk_balanced CHECK (total_debit = total_credit)
);

-- 凭证明细行
CREATE TABLE IF NOT EXISTS public.journal_lines (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  journal_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  account_code text NOT NULL REFERENCES public.accounts(account_code),
  description text,                         -- 行摘要
  debit numeric(15,2) NOT NULL DEFAULT 0,
  credit numeric(15,2) NOT NULL DEFAULT 0,
  currency text DEFAULT 'CNY',
  exchange_rate numeric(10,4) DEFAULT 1,
  original_amount numeric(15,2),            -- 原币金额
  -- 辅助核算
  customer_id uuid REFERENCES public.customers(id),
  supplier_name text,
  order_id uuid REFERENCES public.budget_orders(id),
  CONSTRAINT chk_debit_or_credit CHECK (
    (debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_journal_period ON public.journal_entries(period_code);
CREATE INDEX IF NOT EXISTS idx_journal_source ON public.journal_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON public.journal_lines(account_code);
CREATE INDEX IF NOT EXISTS idx_journal_lines_journal ON public.journal_lines(journal_id);


-- ========== 4. 总账余额表 (General Ledger Balances) ==========

CREATE TABLE IF NOT EXISTS public.gl_balances (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_code text NOT NULL REFERENCES public.accounts(account_code),
  period_code text NOT NULL REFERENCES public.accounting_periods(period_code),
  opening_debit numeric(15,2) NOT NULL DEFAULT 0,
  opening_credit numeric(15,2) NOT NULL DEFAULT 0,
  period_debit numeric(15,2) NOT NULL DEFAULT 0,   -- 本期借方发生额
  period_credit numeric(15,2) NOT NULL DEFAULT 0,  -- 本期贷方发生额
  closing_debit numeric(15,2) NOT NULL DEFAULT 0,  -- 期末借方余额
  closing_credit numeric(15,2) NOT NULL DEFAULT 0, -- 期末贷方余额
  updated_at timestamptz DEFAULT now(),
  UNIQUE(account_code, period_code)
);


-- ========== 5. 银行账户 (Bank Accounts) ==========

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_name text NOT NULL,               -- 如 招商银行-基本户
  bank_name text NOT NULL,                  -- 银行名称
  account_number text NOT NULL UNIQUE,      -- 银行账号
  currency text NOT NULL DEFAULT 'CNY',
  account_code text REFERENCES public.accounts(account_code), -- 关联GL科目
  current_balance numeric(15,2) DEFAULT 0,
  is_active boolean DEFAULT true,
  notes text,
  created_at timestamptz DEFAULT now()
);


-- ========== 6. 凭证号自动生成触发器 ==========

CREATE OR REPLACE FUNCTION generate_voucher_no()
RETURNS TRIGGER AS $$
DECLARE
  prefix text;
  seq_no integer;
BEGIN
  prefix := 'PZ-' || replace(NEW.period_code, '-', '');
  SELECT COALESCE(MAX(CAST(substring(voucher_no FROM length(prefix)+2) AS integer)), 0) + 1
  INTO seq_no
  FROM public.journal_entries
  WHERE voucher_no LIKE prefix || '-%';

  NEW.voucher_no := prefix || '-' || LPAD(seq_no::text, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_voucher_no ON public.journal_entries;
CREATE TRIGGER trg_voucher_no
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW
  WHEN (NEW.voucher_no IS NULL OR NEW.voucher_no = '')
  EXECUTE FUNCTION generate_voucher_no();


-- ========== 7. 期间锁定保护触发器 ==========
-- 已关闭期间禁止新增/修改凭证

CREATE OR REPLACE FUNCTION prevent_closed_period_changes()
RETURNS TRIGGER AS $$
DECLARE
  period_status text;
BEGIN
  SELECT status INTO period_status
  FROM public.accounting_periods
  WHERE period_code = NEW.period_code;

  IF period_status = 'closed' THEN
    RAISE EXCEPTION '会计期间 % 已关闭，不能新增或修改凭证', NEW.period_code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_closed_period_check ON public.journal_entries;
CREATE TRIGGER trg_closed_period_check
  BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_closed_period_changes();


-- ========== 8. 总账余额更新触发器 ==========
-- 凭证posted时自动更新gl_balances

CREATE OR REPLACE FUNCTION update_gl_balances()
RETURNS TRIGGER AS $$
BEGIN
  -- 仅在凭证状态变为posted时触发
  IF NEW.status = 'posted' AND (OLD.status IS NULL OR OLD.status != 'posted') THEN
    -- 遍历凭证明细，更新每个科目的期间余额
    INSERT INTO public.gl_balances (account_code, period_code, period_debit, period_credit)
    SELECT
      jl.account_code,
      NEW.period_code,
      SUM(jl.debit),
      SUM(jl.credit)
    FROM public.journal_lines jl
    WHERE jl.journal_id = NEW.id
    GROUP BY jl.account_code
    ON CONFLICT (account_code, period_code)
    DO UPDATE SET
      period_debit = gl_balances.period_debit + EXCLUDED.period_debit,
      period_credit = gl_balances.period_credit + EXCLUDED.period_credit,
      updated_at = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_gl ON public.journal_entries;
CREATE TRIGGER trg_update_gl
  AFTER INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION update_gl_balances();


-- ========== 9. RLS ==========

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gl_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_accounts" ON public.accounts FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "auth_periods" ON public.accounting_periods FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "auth_journals" ON public.journal_entries FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "auth_journal_lines" ON public.journal_lines FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "auth_gl" ON public.gl_balances FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "auth_bank" ON public.bank_accounts FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
