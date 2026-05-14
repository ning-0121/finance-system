-- ⚠ 一次性引导：在 Supabase Studio SQL Editor 粘贴并执行
-- 之后 npx tsx scripts/apply-migration.ts <file> --via-rpc 即可推送任意 migration
--
-- 该 RPC 仅 service_role 可调（PostgREST 默认行为：execute privilege），
-- anon/authenticated 角色无权调用。

CREATE OR REPLACE FUNCTION public.exec_sql(sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notice text;
BEGIN
  EXECUTE sql;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'detail', SQLSTATE);
END $$;

-- 收回非 service_role 的执行权限（service_role 绕过 RLS，仍可执行）
REVOKE EXECUTE ON FUNCTION public.exec_sql(text) FROM anon, authenticated, public;

DO $$ BEGIN RAISE NOTICE '✓ public.exec_sql(text) 已就绪'; END $$;
