-- 回滚：PO 审批附件链
DROP INDEX IF EXISTS public.idx_uploaded_docs_related_po;
ALTER TABLE public.uploaded_documents DROP COLUMN IF EXISTS doc_hint;
ALTER TABLE public.uploaded_documents DROP COLUMN IF EXISTS related_qimo_order_id;
ALTER TABLE public.uploaded_documents DROP COLUMN IF EXISTS related_purchase_order_id;
