-- 回滚:去掉 received_by 列。⚠️ 财务库执行。
ALTER TABLE public.misc_receivables DROP COLUMN IF EXISTS received_by;
