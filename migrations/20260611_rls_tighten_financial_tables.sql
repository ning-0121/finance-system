-- ============================================================
-- RLS 收紧（决议①）：财务核心表从「任何人可读写 USING(true)」收紧为
--   读取：必须登录（TO authenticated）
--   写入（INSERT/UPDATE）：finance_staff / finance_manager / admin
--   删除（DELETE）：finance_manager / admin
-- 角色取自 public._app_role()（20260608 已建，SECURITY DEFINER 读 profiles.role）。
--
-- 安全效果：泄露的 anon key + 数据库地址不再能绕过系统直接改账。
-- 不影响：service-role（webhook/脚本，天然绕过 RLS）、SECURITY DEFINER RPC、
--         现有两位财务用户（fiona=finance_staff，Su=finance_manager）。
-- ⚠️ 前置条件：本迁移执行前，Vercel 必须已配置 SUPABASE_SERVICE_ROLE_KEY
--    并部署完包含 service 客户端的版本（节拍器 webhook 写库依赖它）。
-- 回滚见 .down.sql（回滚到「登录可读写」，不会回滚到匿名可写）。
-- ============================================================

DO $$
DECLARE
  t text;
  pol record;
  tables text[] := ARRAY[
    'budget_orders', 'cost_items', 'journal_entries', 'journal_lines',
    'gl_balances', 'bank_accounts', 'accounts', 'accounting_periods',
    'payable_records', 'supplier_payments', 'suppliers', 'customers',
    'actual_invoices', 'budget_sub_documents', 'order_settlements',
    'prepayments', 'synced_orders', 'report_snapshots',
    'shipping_documents', 'inventory_returns', 'inventory', 'inventory_transactions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- 表不存在则跳过（环境差异容错）
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '跳过不存在的表: %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- 清掉该表全部旧策略（多为 USING(true) 全开放）
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;

    -- 读：登录即可（业务/采购等只读角色靠此查看）
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_read', t);
    -- 写：财务角色
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin''))',
      t || '_insert_fin', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin'')) WITH CHECK (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin''))',
      t || '_update_fin', t);
    -- 删：财务主管/管理员（财务实体均为软删=UPDATE，硬删仅极少数维护场景）
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (coalesce(public._app_role(), ''none'') IN (''finance_manager'',''admin''))',
      t || '_delete_mgr', t);
  END LOOP;
END $$;

-- 验证：
-- SELECT tablename, policyname, roles, cmd FROM pg_policies
--  WHERE schemaname='public' AND tablename IN ('budget_orders','cost_items','bank_accounts')
--  ORDER BY tablename, policyname;
-- 预期：每表 4 条策略，roles 均为 {authenticated}。
