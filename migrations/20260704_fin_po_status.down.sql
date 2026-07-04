-- 回滚
DROP POLICY IF EXISTS fin_po_update_fin ON public.fin_purchase_orders;
ALTER TABLE public.fin_purchase_orders DROP CONSTRAINT IF EXISTS fin_po_fin_status_chk;
ALTER TABLE public.fin_purchase_orders DROP COLUMN IF EXISTS fin_status;
ALTER TABLE public.fin_purchase_orders DROP COLUMN IF EXISTS processed_at;
ALTER TABLE public.fin_purchase_orders DROP COLUMN IF EXISTS processed_by;
