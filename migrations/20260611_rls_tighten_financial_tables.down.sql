-- 回滚 RLS 收紧：恢复为「登录即可读写」（刻意不回滚到匿名可写——那是安全漏洞）
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
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      t || '_auth_all', t);
  END LOOP;
END $$;
