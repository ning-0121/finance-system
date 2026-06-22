-- 回滚 应付单据号唯一约束
DROP INDEX IF EXISTS public.payable_records_supplier_bill_uniq;
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS bill_no;
