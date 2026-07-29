-- ============================================================
-- 文档三表 RLS 收紧(全面审计二轮 2026-07-28 · P0-1,匿名探针坐实)
--
-- 背景:uploaded_documents / extraction_templates / document_actions 建表时策略为
--   USING(true) 全开(schema-documents.sql:59-64,无 TO authenticated → 含 anon 的 PUBLIC 增删改全开)。
--   20260611_rls_tighten_financial_tables 收紧了 22 张财务核心表,【漏了这三张】。
--   实测:anon key 可直插(撞 NOT NULL 才停)、可读单据行。而提单/CI/客户PO/AI 识别结果全在
--   uploaded_documents 上——持 anon key 者可改 file_url 指向伪造文件、改 doc_hint/related_* 让
--   单据从票/审批视野消失,影响资金决策依据。
--
-- 收紧口径与 20260611 完全一致:读=登录(TO authenticated);写(INSERT/UPDATE)=财务角色;
--   删=财务主管/管理员。写路径核查(2026-07-28):webhook=service client 不受影响;
--   upload/rollback/extract-quote=服务端会话路由(requireAuth,财务在用);documents/[id] 页=
--   财务浏览器会话;executor 已同步切 service client(同一 PR)。
--   演示模式(anon)将读不到文档列表——与 22 张核心表既有口径一致。
-- 可加可逆,回滚见 .down.sql。⚠️ 财务库执行。
-- ============================================================
DO $$
DECLARE
  t text;
  pol record;
  tables text[] := ARRAY['uploaded_documents', 'extraction_templates', 'document_actions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '跳过不存在的表: %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- 清掉该表全部旧策略(v_docs/m_docs 等 USING(true) 全开放)
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_read', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin''))',
      t || '_insert_fin', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin'')) WITH CHECK (coalesce(public._app_role(), ''none'') IN (''finance_staff'',''finance_manager'',''admin''))',
      t || '_update_fin', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (coalesce(public._app_role(), ''none'') IN (''finance_manager'',''admin''))',
      t || '_delete_mgr', t);
  END LOOP;
END $$;

-- 验证:
-- SELECT tablename, policyname, roles, cmd FROM pg_policies
--   WHERE tablename IN ('uploaded_documents','extraction_templates','document_actions') ORDER BY 1,2;
-- 预期:每表 4 条策略,roles 均 {authenticated}。
