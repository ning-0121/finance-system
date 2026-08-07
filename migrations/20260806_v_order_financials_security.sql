-- ============================================================
-- 修:v_order_financials 匿名可读(2026-08-06 上线后自查发现)
--
-- 现象:用 anon key 直接查该视图,返回全部 644 行订单财务数据
--   (收入、成本、利润、客户名全在里面)——【未登录即可读全量财务数据】。
--
-- 根因两条,缺一不可:
--  ① Postgres 视图默认以【视图属主】权限执行,底表的 RLS 不生效
--     (PG15 起可用 security_invoker=true 让视图改以调用者身份执行,
--      底表 RLS 才会套用)。
--  ② 建视图时虽只写了 GRANT SELECT TO authenticated,但 PUBLIC 仍持有
--     默认权限,anon 属于 PUBLIC,于是照样读得到。
--
-- 本仓 2026-07-28 审计出过同类问题(文档三表 RLS 全开),属复发,故两条一起堵死:
--   · security_invoker=true —— 底表 RLS 重新生效
--   · REVOKE FROM PUBLIC/anon,只留 authenticated
--
-- 只改视图属性与授权,不动数据。回滚见 .down.sql。⚠️ 财务库执行。
-- ============================================================

-- ① 让视图以调用者身份执行,底表 RLS 生效
ALTER VIEW public.v_order_financials SET (security_invoker = true);

-- ② 收回 PUBLIC / anon 的权限,只留登录用户
REVOKE ALL ON public.v_order_financials FROM PUBLIC;
REVOKE ALL ON public.v_order_financials FROM anon;
GRANT SELECT ON public.v_order_financials TO authenticated;

-- 自验证:确认 security_invoker 已开
DO $$
DECLARE v text;
BEGIN
  SELECT c.reloptions::text INTO v
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public' AND c.relname = 'v_order_financials';
  IF v IS NULL OR v NOT LIKE '%security_invoker=true%' THEN
    RAISE EXCEPTION 'security_invoker 未生效,当前 reloptions=%', COALESCE(v, '(null)');
  END IF;
  RAISE NOTICE '✓ v_order_financials 已切 security_invoker 并收回 anon 权限';
END $$;
