-- rollback: Wave 2 atomic RPCs
DROP FUNCTION IF EXISTS public.record_customer_receipt_atomic(uuid, text, numeric, text, date, uuid, text, text);
DROP FUNCTION IF EXISTS public.confirm_settlement_with_payables_atomic(uuid, uuid, text, jsonb);
