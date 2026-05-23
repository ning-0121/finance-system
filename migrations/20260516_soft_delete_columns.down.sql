-- ============================================================
-- Wave 1-A 回滚：撤销 soft delete infrastructure
-- ============================================================
-- 注意：如果生产环境已经有软删除数据（deleted_at IS NOT NULL），
-- 回滚会丢失这部分审计信息——必须先备份。
-- ============================================================

-- 1. 移除触发器
DO $$
DECLARE
  t text;
  financial_tables text[] := ARRAY[
    'actual_invoices','payable_records','order_settlements','budget_orders',
    'shipping_documents','financial_risk_events','cost_items',
    'journal_entries','journal_lines'
  ];
BEGIN
  FOREACH t IN ARRAY financial_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_no_hard_delete ON public.%I', t);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.financial_hard_delete_guard() CASCADE;
DROP FUNCTION IF EXISTS public._admin_hard_delete(text, uuid, text) CASCADE;

-- 2. 移除 partial 索引
DROP INDEX IF EXISTS public.idx_actual_invoices_active;
DROP INDEX IF EXISTS public.idx_payable_records_active;
DROP INDEX IF EXISTS public.idx_order_settlements_active;
DROP INDEX IF EXISTS public.idx_budget_orders_active;
DROP INDEX IF EXISTS public.idx_shipping_documents_active;
DROP INDEX IF EXISTS public.idx_financial_risk_events_active;
DROP INDEX IF EXISTS public.idx_cost_items_active;
DROP INDEX IF EXISTS public.idx_journal_entries_active;
DROP INDEX IF EXISTS public.idx_journal_lines_active;

-- 3. 移除列（注意：cost_items 上 deleted_at / deleted_by 是历史已有，回滚也会丢）
-- 如果不想丢历史列，注释掉 cost_items 部分
DO $$
DECLARE
  t text;
  financial_tables text[] := ARRAY[
    'actual_invoices','payable_records','order_settlements','budget_orders',
    'shipping_documents','financial_risk_events','cost_items',
    'journal_entries','journal_lines'
  ];
BEGIN
  FOREACH t IN ARRAY financial_tables LOOP
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS delete_reason', t);
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS deleted_by', t);
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS deleted_at', t);
  END LOOP;
END $$;

DO $$ BEGIN RAISE NOTICE 'Wave 1-A 已回滚'; END $$;
