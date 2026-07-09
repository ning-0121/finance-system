-- ============================================================
-- 回款流水加「水单照片」附件列
-- 登记回款时上传银行水单/回单照片，路径存本列（私有桶 finance-attachments，
-- 桶与 RLS 见 20260609_finance_attachments_storage.sql，无需重建）。
-- 可加可逆。回滚见 .down.sql
-- ============================================================

ALTER TABLE public.receivable_payments ADD COLUMN IF NOT EXISTS attachment_url text;

-- 验证：
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='receivable_payments' AND column_name='attachment_url';
