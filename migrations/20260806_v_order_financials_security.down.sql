-- 回滚:v_order_financials 安全加固(20260806)
-- ⚠️ 回滚会让该视图重新绕过底表 RLS,并把权限放回 PUBLIC(匿名可读全量财务数据)。
-- 除非确有必要,不要回滚这一条。
ALTER VIEW public.v_order_financials SET (security_invoker = false);
GRANT SELECT ON public.v_order_financials TO PUBLIC;
