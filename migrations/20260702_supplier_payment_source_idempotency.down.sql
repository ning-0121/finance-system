-- 回滚
DROP INDEX IF EXISTS public.supplier_payments_source_payable_uniq;
ALTER TABLE public.supplier_payments DROP COLUMN IF EXISTS source_payable_id;
