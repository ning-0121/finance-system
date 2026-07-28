-- 回滚:出运票级建模(仅在确无数据/需回退时)。⚠️ 财务库执行。
ALTER TABLE public.uploaded_documents DROP COLUMN IF EXISTS related_shipment_id;
DROP TABLE IF EXISTS public.shipment_orders;
DROP TABLE IF EXISTS public.shipments;
