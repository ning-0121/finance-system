-- 回滚 20260705_payment_batch_schema.sql
-- 注意：若已有排款单/实付引用,请先处置数据再回滚。
DROP INDEX IF EXISTS public.supplier_payments_batch_line_uniq;
ALTER TABLE public.supplier_payments DROP COLUMN IF EXISTS source_batch_line_id;

DROP TABLE IF EXISTS public.payment_batch_lines;   -- 需先 _admin_hard_delete 绕过硬删防护,或直接 DROP(DDL 不受行触发器限制)
DROP TABLE IF EXISTS public.payment_batches;

-- payable_records 状态约束回退(去掉 partially_paid)
DO $$
BEGIN
  ALTER TABLE public.payable_records DROP CONSTRAINT IF EXISTS payable_records_payment_status_check;
  ALTER TABLE public.payable_records ADD CONSTRAINT payable_records_payment_status_check
    CHECK (payment_status IN ('unpaid','pending_approval','approved','paid','cancelled'));
EXCEPTION WHEN others THEN RAISE NOTICE '状态约束回退跳过: %', SQLERRM;
END $$;

-- _admin_hard_delete 白名单回退(去掉三张新表)
CREATE OR REPLACE FUNCTION public._admin_hard_delete(
  p_table text, p_id uuid, p_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count integer;
  v_allowed text[] := ARRAY[
    'actual_invoices','payable_records','order_settlements','budget_orders',
    'shipping_documents','financial_risk_events','cost_items',
    'journal_entries','journal_lines'
  ];
BEGIN
  IF NOT (p_table = ANY(v_allowed)) THEN
    RAISE EXCEPTION '_admin_hard_delete: 表 % 不在受保护清单内', p_table;
  END IF;
  PERFORM set_config('financial.allow_hard_delete', 'on', true);
  EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_table) USING p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('table', p_table, 'id', p_id, 'deleted_rows', v_count,
    'reason', p_reason, 'executed_at', now());
END $$;
REVOKE ALL ON FUNCTION public._admin_hard_delete(text, uuid, text) FROM PUBLIC, anon, authenticated;
