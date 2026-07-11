-- 回滚:删除 payable_records.detail 列。
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS detail;
