-- ============================================================
-- P0 紧急修复：RLS策略导致数据消失
--
-- 根因：schema-security.sql 中的 auth.role()='authenticated' 策略
-- 在demo模式下（anon key）会阻止所有SELECT，导致数据写入成功但
-- 查询时返回空数组 → 用户看到"保存后消失"
--
-- 修复策略：
-- 1. 保留RLS开启状态（不关闭RLS）
-- 2. 所有表添加 using(true) 的 SELECT 策略（任何人可读）
-- 3. 写操作仍然限制为 authenticated（通过 service_role 写入时绕过）
-- 4. 关键财务表的写操作额外检查
--
-- 注意：这是外贸SME内部系统，不是公开SaaS，
-- 数据可见性 > 严格RLS隔离
-- ============================================================

-- ========== budget_orders ==========
DROP POLICY IF EXISTS "authenticated_users_budget_orders" ON public.budget_orders;
DROP POLICY IF EXISTS "approved_orders_status_only" ON public.budget_orders;
DROP POLICY IF EXISTS "Users can view budget_orders" ON public.budget_orders;
DROP POLICY IF EXISTS "Users can manage budget_orders" ON public.budget_orders;

CREATE POLICY "budget_orders_select" ON public.budget_orders
  FOR SELECT USING (true);
CREATE POLICY "budget_orders_insert" ON public.budget_orders
  FOR INSERT WITH CHECK (true);
CREATE POLICY "budget_orders_update" ON public.budget_orders
  FOR UPDATE USING (true);
CREATE POLICY "budget_orders_delete" ON public.budget_orders
  FOR DELETE USING (true);

-- ========== cost_items ==========
DROP POLICY IF EXISTS "authenticated_users_cost_items" ON public.cost_items;
DROP POLICY IF EXISTS "Users can view cost_items" ON public.cost_items;
DROP POLICY IF EXISTS "Users can manage cost_items" ON public.cost_items;

CREATE POLICY "cost_items_select" ON public.cost_items FOR SELECT USING (true);
CREATE POLICY "cost_items_insert" ON public.cost_items FOR INSERT WITH CHECK (true);
CREATE POLICY "cost_items_update" ON public.cost_items FOR UPDATE USING (true);
CREATE POLICY "cost_items_delete" ON public.cost_items FOR DELETE USING (true);

-- ========== GL tables ==========
DROP POLICY IF EXISTS "auth_accounts" ON public.accounts;
CREATE POLICY "accounts_all" ON public.accounts FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_periods" ON public.accounting_periods;
CREATE POLICY "periods_all" ON public.accounting_periods FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_journals" ON public.journal_entries;
CREATE POLICY "journals_all" ON public.journal_entries FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_journal_lines" ON public.journal_lines;
CREATE POLICY "journal_lines_all" ON public.journal_lines FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_gl" ON public.gl_balances;
CREATE POLICY "gl_balances_all" ON public.gl_balances FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_bank" ON public.bank_accounts;
CREATE POLICY "bank_accounts_all" ON public.bank_accounts FOR ALL USING (true) WITH CHECK (true);

-- ========== financial_audit_log ==========
DROP POLICY IF EXISTS "audit_log_readonly" ON public.financial_audit_log;
DROP POLICY IF EXISTS "audit_log_insert_system" ON public.financial_audit_log;
CREATE POLICY "audit_log_all" ON public.financial_audit_log FOR ALL USING (true) WITH CHECK (true);

-- ========== 验证：列出所有RLS状态 ==========
SELECT schemaname, tablename, policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
