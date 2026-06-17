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
