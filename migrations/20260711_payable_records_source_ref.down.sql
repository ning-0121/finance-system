-- 回滚 20260711_payable_records_source_ref.sql
DROP INDEX IF EXISTS public.payable_records_source_ref_uniq;
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS source_ref;
