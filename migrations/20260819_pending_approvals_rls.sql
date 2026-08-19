-- ============================================================
-- 修:pending_approvals 匿名可读(2026-08-19 第四轮审计发现,RLS 缺失第四次发作)
--
-- 探针实测:anon key 可读整表 —— approval_type/order_no/summary/detail(含金额、
-- 客户名、申请人)【未登录即可全量拉取】。同类前科:2026-07-28 文档三表、
-- 2026-08-06 v_order_financials、2026-08-12 integration_logs。
--
-- 写入方核查:插入=webhook(service client);决策=/api/integration/approve、
-- /api/integration/reopen(service client + requireRole);UI 仅 SELECT(authed)。
-- 故只放 authenticated 读、不设写策略即可,业务零影响。
-- 可逆,回滚见 .down.sql。⚠️ 财务库执行。
-- ============================================================
ALTER TABLE public.pending_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pending_approvals_read ON public.pending_approvals;
CREATE POLICY pending_approvals_read ON public.pending_approvals
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.pending_approvals FROM anon;

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.pending_approvals'::regclass) THEN
    RAISE EXCEPTION 'pending_approvals RLS 未启用';
  END IF;
  RAISE NOTICE '✓ pending_approvals RLS 已启用(读=登录,写=仅服务端)';
END $$;
