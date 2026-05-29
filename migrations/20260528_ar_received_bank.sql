-- 应收账款：实际收款银行（钱打到了哪个银行账户）
-- 加列幂等，不动任何现有数据。
ALTER TABLE public.budget_orders
  ADD COLUMN IF NOT EXISTS ar_received_bank text;

COMMENT ON COLUMN public.budget_orders.ar_received_bank IS '实际收款银行/账户（如：工行义乌分行 6222...）；登记收款时记录，便于核对回款流向';
