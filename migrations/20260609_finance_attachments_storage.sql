-- ============================================================
-- 财务附件存储桶 + 付款申请附件列
-- 私有桶 finance-attachments；authenticated 可读写本桶对象（与系统口径一致）。
-- 可加可逆。回滚见 .down.sql
-- ============================================================

-- 1) 私有存储桶
INSERT INTO storage.buckets (id, name, public)
VALUES ('finance-attachments', 'finance-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- 2) storage.objects 上本桶的 RLS（authenticated 读写）
DROP POLICY IF EXISTS "fin_attach_read"   ON storage.objects;
DROP POLICY IF EXISTS "fin_attach_write"  ON storage.objects;
DROP POLICY IF EXISTS "fin_attach_update" ON storage.objects;
DROP POLICY IF EXISTS "fin_attach_delete" ON storage.objects;
CREATE POLICY "fin_attach_read"   ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'finance-attachments');
CREATE POLICY "fin_attach_write"  ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'finance-attachments');
CREATE POLICY "fin_attach_update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'finance-attachments');
CREATE POLICY "fin_attach_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'finance-attachments');

-- 3) 付款申请附件列
ALTER TABLE public.payable_records ADD COLUMN IF NOT EXISTS attachment_url text;

-- 验证：
-- SELECT id FROM storage.buckets WHERE id='finance-attachments';
-- SELECT column_name FROM information_schema.columns WHERE table_name='payable_records' AND column_name='attachment_url';
