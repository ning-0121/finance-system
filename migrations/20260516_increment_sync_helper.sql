-- Wave 1-E P0: 把 webhook 内的 SQL 字符串插值替换为参数化 RPC

CREATE OR REPLACE FUNCTION public.increment_sync_attempt(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.synced_orders
  SET budget_sync_attempt_count = budget_sync_attempt_count + 1
  WHERE id = p_id;
END $$;

-- 允许 service_role + authenticated 调用
REVOKE ALL ON FUNCTION public.increment_sync_attempt(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_sync_attempt(uuid) TO authenticated, service_role;

DO $$ BEGIN RAISE NOTICE '✓ increment_sync_attempt(uuid) 已就绪'; END $$;
