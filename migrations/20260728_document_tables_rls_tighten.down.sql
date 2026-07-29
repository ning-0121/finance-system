-- 回滚:文档三表恢复到「登录可读写」(不回滚到匿名全开;仅紧急回退用)。⚠️ 财务库执行。
DO $$
DECLARE
  t text;
  pol record;
  tables text[] := ARRAY['uploaded_documents', 'extraction_templates', 'document_actions'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t || '_all', t);
  END LOOP;
END $$;
