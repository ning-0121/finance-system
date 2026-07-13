-- ============================================================
-- integration_logs.status 加 'warning' —— 修「止血告警全静默失败」(审计P1.9)
-- 表原 CHECK 只允许 success/failed/pending,而 logFinancialDrop/金额差异/CI差异 等
-- 全部 insert status='warning' → 23514 违约被 try/catch 吞成 console.error,
-- 实测 integration_logs 410 行 0 warning:P0-1「止血静默丢弃」本身在静默失败。
-- 可加可逆,回滚见 .down.sql
-- ============================================================

ALTER TABLE public.integration_logs DROP CONSTRAINT IF EXISTS integration_logs_status_check;
ALTER TABLE public.integration_logs ADD CONSTRAINT integration_logs_status_check
  CHECK (status IN ('success', 'failed', 'pending', 'warning'));

-- 验证：
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='integration_logs_status_check';
