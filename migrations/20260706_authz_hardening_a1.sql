-- ============================================================
-- 批A-1 授权加固(审计 P0 + 授权簇)· 关 anon 越权,零函数体改写
--
-- ① 结算/回款/GL 四个 SECURITY DEFINER RPC 从未 REVOKE PUBLIC → anon(公开浏览器 key)
--    可直接 rpc() 绕 RLS 写真账。REVOKE PUBLIC/anon + 只 GRANT authenticated/service_role。
-- ② gl_posting_queue 四条 RLS 策略 USING(true) 无 TO 子句 = 对 anon 也开 → 收紧到 authenticated,
--    写入要财务角色。
-- ③ financial_provenance INSERT WITH CHECK(true) 无 TO → anon 可伪造溯源台账 → 收紧 authenticated。
-- ④ supplier_payments(实付流水台账)缺硬删防护触发器 → 补 trg_no_hard_delete。
--
-- 全加法式、幂等、不改任何函数逻辑。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================

-- ① RPC 授权:关 anon(confirm_settlement 由结算路由 server client+requireRole 调,安全)
--    ⚠️ record_customer_receipt_atomic 暂不在此关 —— 其调用方 executor 用的是浏览器 client,
--    直接 REVOKE anon 可能打断"文档识别→登记回款"。改用 service client 后单独关(见 a1b)。
REVOKE ALL ON FUNCTION public.confirm_settlement_with_payables_atomic(uuid, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_settlement_with_payables_atomic(uuid, uuid, text, jsonb) TO authenticated, service_role;

-- GL:post_journal / create_journal_draft 从未 REVOKE PUBLIC → anon 可直接过账/建草稿。关掉。
--    (post_journal 由 gl/journal/post 路由 server client+requireRole 调;create_journal_draft 由 gl-queue server client 调,均安全)
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('post_journal','create_journal_draft')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END $do$;

-- ② gl_posting_queue RLS:读=登录;写=财务角色(不再对 anon/任意登录全开)
DROP POLICY IF EXISTS "gl_queue_select" ON public.gl_posting_queue;
DROP POLICY IF EXISTS "gl_queue_insert" ON public.gl_posting_queue;
DROP POLICY IF EXISTS "gl_queue_update" ON public.gl_posting_queue;
DROP POLICY IF EXISTS "gl_queue_delete" ON public.gl_posting_queue;
CREATE POLICY "gl_queue_select" ON public.gl_posting_queue FOR SELECT TO authenticated USING (true);
CREATE POLICY "gl_queue_insert" ON public.gl_posting_queue FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY "gl_queue_update" ON public.gl_posting_queue FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY "gl_queue_delete" ON public.gl_posting_queue FOR DELETE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- ③ financial_provenance INSERT 收紧到 authenticated(anon 不可伪造溯源;真写入走 SECURITY DEFINER 触发器仍不受限)
DROP POLICY IF EXISTS "fp_write_via_trigger" ON public.financial_provenance;
CREATE POLICY "fp_write_via_trigger" ON public.financial_provenance FOR INSERT TO authenticated WITH CHECK (true);

-- ④ supplier_payments 补硬删防护(复用 financial_hard_delete_guard;此前只护9张表+排款表,漏了实付台账)
DROP TRIGGER IF EXISTS trg_no_hard_delete ON public.supplier_payments;
CREATE TRIGGER trg_no_hard_delete BEFORE DELETE ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public.financial_hard_delete_guard();

-- 自验证
DO $do$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_trigger WHERE tgname='trg_no_hard_delete'
    AND tgrelid='public.supplier_payments'::regclass;
  IF v < 1 THEN RAISE EXCEPTION 'supplier_payments 硬删触发器未挂上'; END IF;
  RAISE NOTICE '✓ 批A-1:结算/回款/GL RPC 已关 anon;gl_posting_queue/financial_provenance RLS 收紧;supplier_payments 硬删防护已补';
END $do$;
