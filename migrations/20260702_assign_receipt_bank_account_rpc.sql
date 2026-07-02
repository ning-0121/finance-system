-- ============================================================
-- 修复：银行日记账「归集收款到账户」静默失败
-- 背景：receivable_payments 自 20260608 起收紧 RLS（只 SELECT+INSERT，
--       UPDATE/DELETE 不开放，一切走 RPC）。银行日记账的归集用普通 client
--       .update({bank_account_id}) 被 RLS 过滤为 0 行且不报错 → 假成功、
--       收款永远进不了日记账。
-- 方案：加 SECURITY DEFINER RPC 专门写 bank_account_id（校验财务角色 +
--       未作废），供应商付款侧因有 FOR UPDATE 策略无需 RPC。
-- 可加可逆（回滚见 .down.sql）。
-- ============================================================
CREATE OR REPLACE FUNCTION public.assign_receipt_bank_account(
  p_receipt_id uuid,
  p_account_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_staff','finance_manager','admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: 归集账户需财务权限'; END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.bank_accounts WHERE id = p_account_id) THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND'; END IF;

  UPDATE public.receivable_payments
     SET bank_account_id = p_account_id, updated_at = now()
   WHERE id = p_receipt_id AND voided_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECEIPT_NOT_FOUND_OR_VOIDED'; END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.assign_receipt_bank_account(uuid, uuid) TO authenticated;
