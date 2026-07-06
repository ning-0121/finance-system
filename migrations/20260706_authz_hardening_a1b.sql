-- ============================================================
-- 批A-1b 授权加固:关 record_customer_receipt_atomic 的 anon
-- ⚠️ 必须在【executor 改用 service client 的代码已部署】之后再跑,否则会打断
--    "文档识别→登记客户回款"(executor 原用浏览器 client=anon 调此 RPC)。
-- 代码改动:src/lib/document-engine/executor.ts 该 RPC 改走 createServiceClient()。
-- 加法式、幂等。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
REVOKE ALL ON FUNCTION public.record_customer_receipt_atomic(uuid, text, numeric, text, date, uuid, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_receipt_atomic(uuid, text, numeric, text, date, uuid, text, text, numeric) TO authenticated, service_role;

DO $do$ BEGIN RAISE NOTICE '✓ 批A-1b:record_customer_receipt_atomic 已关 anon(确认 executor service client 代码已部署)'; END $do$;
