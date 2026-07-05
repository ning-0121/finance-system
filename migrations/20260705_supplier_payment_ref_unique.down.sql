-- 回滚：移除付款凭证号唯一索引与列
DROP INDEX IF EXISTS public.supplier_payments_supplier_ref_uniq;
ALTER TABLE public.supplier_payments DROP COLUMN IF EXISTS payment_ref;
