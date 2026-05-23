-- rollback: auto-settlement
DROP TRIGGER IF EXISTS trg_settlement_confirm_human ON public.order_settlements;
DROP TRIGGER IF EXISTS trg_auto_settlement_on_ship_complete ON public.shipping_documents;
DROP FUNCTION IF EXISTS public.trg_settlement_confirm_requires_human();
DROP FUNCTION IF EXISTS public.trg_auto_create_settlement_on_shipping_complete();
DROP INDEX IF EXISTS uniq_order_settlements_active_per_order;
ALTER TABLE public.order_settlements
  DROP COLUMN IF EXISTS source_shipping_id,
  DROP COLUMN IF EXISTS auto_generated;
