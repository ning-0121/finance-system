-- 回滚 财务附件存储
DROP POLICY IF EXISTS "fin_attach_read"   ON storage.objects;
DROP POLICY IF EXISTS "fin_attach_write"  ON storage.objects;
DROP POLICY IF EXISTS "fin_attach_update" ON storage.objects;
DROP POLICY IF EXISTS "fin_attach_delete" ON storage.objects;
-- 桶内可能已有对象，不自动删桶（需先清空）：手动 DELETE FROM storage.objects WHERE bucket_id='finance-attachments'; 再 DELETE FROM storage.buckets WHERE id='finance-attachments';
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS attachment_url;
