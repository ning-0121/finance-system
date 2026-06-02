-- 回滚 GL 受控灰度基础设施
-- 注意：删除 gl_posting_queue 会丢失排队/失败记录；provenance 列删除不影响既有凭证金额。
-- 已生成的 draft 凭证不会被本回滚删除（如需清理请单独处理）。

DROP FUNCTION IF EXISTS public.post_journal(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_journal_draft(
  text, date, text, text, uuid, numeric, numeric, uuid, jsonb, text, text, uuid,
  uuid, uuid, text, uuid, text, text, boolean
);

DROP TABLE IF EXISTS public.gl_posting_queue;

ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS business_event;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS source_document_id;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS posting_queue_id;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS related_order_id;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS related_customer_id;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS related_supplier_name;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS exchange_rate_source;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS explanation;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS requires_review;
ALTER TABLE public.journal_entries DROP COLUMN IF EXISTS approved_by;
