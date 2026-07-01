-- 回滚：移除付款方式/收款人补充字段
ALTER TABLE public.payable_records DROP CONSTRAINT IF EXISTS payable_records_payment_channel_chk;
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS payment_channel;
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS payee_name;
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS payee_account;
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS payee_bank;
