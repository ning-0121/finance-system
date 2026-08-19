-- 回滚:pending_approvals RLS(恢复到 2026-08-19 前状态:无 RLS、PUBLIC 默认可读)
-- ⚠️ 回滚即重新暴露匿名读,仅在 RLS 误伤业务时临时使用。
DROP POLICY IF EXISTS pending_approvals_read ON public.pending_approvals;
ALTER TABLE public.pending_approvals DISABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.pending_approvals TO anon;
