-- ============================================================
-- PO 审批附件链：节拍器推送的附件(PO 单据/内部报价单)关联到采购单
-- uploaded_documents 加三列：
--   related_purchase_order_id  节拍器采购单 id(对应 fin_purchase_orders.purchase_order_id, text)
--   related_qimo_order_id      节拍器订单 id(对应 synced_orders.id)
--   doc_hint                   节拍器侧已知的文档类型提示('po' / 'internal_quote' / 其他)
-- 均可空、无 FK(跨系统弱引用)，可加可逆，回滚见 .down.sql
-- ============================================================

ALTER TABLE public.uploaded_documents ADD COLUMN IF NOT EXISTS related_purchase_order_id text;
ALTER TABLE public.uploaded_documents ADD COLUMN IF NOT EXISTS related_qimo_order_id uuid;
ALTER TABLE public.uploaded_documents ADD COLUMN IF NOT EXISTS doc_hint text;

CREATE INDEX IF NOT EXISTS idx_uploaded_docs_related_po
  ON public.uploaded_documents (related_purchase_order_id)
  WHERE related_purchase_order_id IS NOT NULL;

-- 验证：
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='uploaded_documents'
--    AND column_name IN ('related_purchase_order_id','related_qimo_order_id','doc_hint');
