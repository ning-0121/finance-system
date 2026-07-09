-- 回滚：移除回款流水「水单照片」附件列
ALTER TABLE public.receivable_payments DROP COLUMN IF EXISTS attachment_url;
