-- ============================================================
-- 银行日记账（企业侧现金流水账）
-- 方案：自动汇入(收=回款流水 + 付=供应商付款流水) + 手工补录(手续费/税/工资/
--       内部转账/利息/取现/其他)。单一数据源，不重复录入。
-- 账户范围：银行 / 支付宝 / 微信 / 现金（统一放 bank_accounts）。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

-- 1) 账户档案扩展：账户类型 + 期初余额（日记账逐笔余额的起点）
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS account_type text;   -- bank/alipay/wechat/cash
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS opening_balance numeric(15,2) NOT NULL DEFAULT 0;
ALTER TABLE public.bank_accounts ADD COLUMN IF NOT EXISTS opening_date date;
ALTER TABLE public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_account_type_chk;
ALTER TABLE public.bank_accounts ADD CONSTRAINT bank_accounts_account_type_chk
  CHECK (account_type IS NULL OR account_type IN ('bank','alipay','wechat','cash'));

-- 2) 收/付流水归集到账户（用于日记账逐笔余额；历史数据 NULL=未归集，可一键归集）
ALTER TABLE public.receivable_payments ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES public.bank_accounts(id);
ALTER TABLE public.supplier_payments   ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES public.bank_accounts(id);
CREATE INDEX IF NOT EXISTS idx_recv_pay_bank_account ON public.receivable_payments(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_supp_pay_bank_account ON public.supplier_payments(bank_account_id);

-- 3) 手工补录表：没有对应收/付的现金动作
CREATE TABLE IF NOT EXISTS public.bank_journal_manual (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id),
  txn_date date NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in','out')),   -- in=收/进  out=付/出
  amount numeric(15,2) NOT NULL CHECK (amount > 0),            -- 恒正，方向由 direction 表示
  currency text NOT NULL DEFAULT 'CNY',
  category text,                                               -- 手续费/税费/工资/内部转账/利息/取现/其他收入/其他支出
  counterparty text,                                           -- 对方单位/收付对象
  summary text,                                                -- 摘要/用途
  reference text,                                              -- 凭证号/流水号
  transfer_group uuid,                                         -- 内部转账配对（一出一进同组）
  attachment_url text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.profiles(id),
  delete_reason text
);
CREATE INDEX IF NOT EXISTS idx_bjm_account_date ON public.bank_journal_manual(bank_account_id, txn_date);

-- 4) RLS（与 bank_transactions 一致：全员读；财务写；主管删）
ALTER TABLE public.bank_journal_manual ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bjm_read       ON public.bank_journal_manual;
DROP POLICY IF EXISTS bjm_insert_fin ON public.bank_journal_manual;
DROP POLICY IF EXISTS bjm_update_fin ON public.bank_journal_manual;
DROP POLICY IF EXISTS bjm_delete_fin ON public.bank_journal_manual;
CREATE POLICY bjm_read ON public.bank_journal_manual
  FOR SELECT TO authenticated USING (true);
CREATE POLICY bjm_insert_fin ON public.bank_journal_manual
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY bjm_update_fin ON public.bank_journal_manual
  FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY bjm_delete_fin ON public.bank_journal_manual
  FOR DELETE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));

-- 验证：
-- SELECT count(*) FROM public.bank_journal_manual;
-- SELECT column_name FROM information_schema.columns WHERE table_name='bank_accounts' AND column_name IN ('opening_balance','account_type');
