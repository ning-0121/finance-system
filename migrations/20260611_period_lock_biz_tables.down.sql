-- 回滚 业务表期间锁
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cost_items', 'receivable_payments', 'receivable_payment_allocations',
    'supplier_payments', 'payable_records', 'order_settlements'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_closed_period_biz ON public.%I', t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.prevent_closed_period_biz_changes();
DROP FUNCTION IF EXISTS public._closed_period_check(date, text);
DROP FUNCTION IF EXISTS public._biz_date_of(jsonb, text);
