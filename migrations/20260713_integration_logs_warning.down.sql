-- 回滚：integration_logs 去掉 'warning'(注意:若已有 warning 行需先清理,否则加约束会失败)
ALTER TABLE public.integration_logs DROP CONSTRAINT IF EXISTS integration_logs_status_check;
ALTER TABLE public.integration_logs ADD CONSTRAINT integration_logs_status_check
  CHECK (status IN ('success', 'failed', 'pending'));
