-- ============================================================
-- 审计修复 C3：为 supplier_payments 启用 RLS（与系统既有口径一致）
--
-- 背景：
--   全面审计发现 supplier_payments 是唯一一张「未启用 RLS」的财务表，
--   会触发 Supabase 安全告警（rls_disabled_in_public）。
--
-- 设计取舍（重要，勿改为 authenticated-only）：
--   本系统是外贸 SME 内部系统，前端用 anon key 直连 Supabase。
--   历史上把策略收紧为 auth.role()='authenticated' 曾导致
--   「保存成功但查询返回空 → 数据看起来消失」的 P0 事故
--   （见 src/lib/supabase/schema-rls-fix.sql）。财务对「数据消失」
--   极度敏感，因此全系统统一采用 USING(true) 的可见优先策略。
--
--   本迁移让 supplier_payments 与 budget_orders / cost_items /
--   journal_lines 等表保持完全一致：RLS 开启 + USING(true)。
--   这不会增加真实隔离强度，但消除了「唯一无 RLS 表」的不一致与告警。
--
--   ⚠️ 真正的写入鉴权（按角色限制增删改）需要把财务写操作迁到
--   服务端 API（走 src/lib/auth/api-guard.ts 的角色校验），属于
--   独立的架构改造，不在本迁移范围内。
--
-- 安全性：可加可逆。ENABLE RLS 是幂等的；CREATE POLICY 前先 DROP。
-- 回滚见 20260528_supplier_payments_rls.down.sql
-- ============================================================

ALTER TABLE public.supplier_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "supplier_payments_select" ON public.supplier_payments;
DROP POLICY IF EXISTS "supplier_payments_insert" ON public.supplier_payments;
DROP POLICY IF EXISTS "supplier_payments_update" ON public.supplier_payments;
DROP POLICY IF EXISTS "supplier_payments_delete" ON public.supplier_payments;

CREATE POLICY "supplier_payments_select" ON public.supplier_payments
  FOR SELECT USING (true);
CREATE POLICY "supplier_payments_insert" ON public.supplier_payments
  FOR INSERT WITH CHECK (true);
CREATE POLICY "supplier_payments_update" ON public.supplier_payments
  FOR UPDATE USING (true);
CREATE POLICY "supplier_payments_delete" ON public.supplier_payments
  FOR DELETE USING (true);

-- 验证：应看到 4 条策略 + rowsecurity = true
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'supplier_payments';
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'supplier_payments';
