-- 回滚:integration_logs RLS(20260812)
-- ⚠️ 回滚后匿名将再次可读全表(含订单号/客户名/金额),勿轻易执行。
DROP POLICY IF EXISTS integration_logs_read ON public.integration_logs;
ALTER TABLE public.integration_logs DISABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.integration_logs TO anon;
