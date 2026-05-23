-- rollback: Wave 3-A
ALTER TABLE public.document_actions DROP COLUMN IF EXISTS execution_error;
DROP TRIGGER IF EXISTS trg_synced_orders_version ON public.synced_orders;
DROP FUNCTION IF EXISTS public.trg_synced_orders_bump_version();
ALTER TABLE public.synced_orders DROP COLUMN IF EXISTS version;
DROP FUNCTION IF EXISTS public.get_or_create_customer(text, text);
DROP INDEX IF EXISTS uniq_payable_settlement_invoice;
