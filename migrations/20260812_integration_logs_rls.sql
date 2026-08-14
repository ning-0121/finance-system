-- ============================================================
-- 修:integration_logs 匿名可读(2026-08-12 第三轮审计发现)
--
-- 探针实测:anon key 可读全表 841 行 —— payload_summary 里有订单号/客户名/金额,
-- error_message 里有内部实现细节,【未登录即可全量拉取】。
-- 与 2026-07-28(文档三表)、2026-08-06(v_order_financials)同类,第三次发作:
-- 建表时没开 RLS,PUBLIC 默认权限让 anon 直读。
--
-- 写入方核查:全部在服务端路由用 service client(webhook/finance-alerts),
-- service 角色绕过 RLS,故只放 authenticated 读、不设任何写策略即可,业务不受影响。
-- 可逆,回滚见 .down.sql。⚠️ 财务库执行。
-- ============================================================
ALTER TABLE public.integration_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_logs_read ON public.integration_logs;
CREATE POLICY integration_logs_read ON public.integration_logs
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.integration_logs FROM anon;

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.integration_logs'::regclass) THEN
    RAISE EXCEPTION 'integration_logs RLS 未启用';
  END IF;
  RAISE NOTICE '✓ integration_logs RLS 已启用(读=登录,写=仅服务端)';
END $$;
