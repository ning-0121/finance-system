-- 回滚：移除客户银行信息字段
ALTER TABLE public.customers DROP COLUMN IF EXISTS account_name;
ALTER TABLE public.customers DROP COLUMN IF EXISTS account_no;
ALTER TABLE public.customers DROP COLUMN IF EXISTS bank_name;
ALTER TABLE public.customers DROP COLUMN IF EXISTS swift_code;
ALTER TABLE public.customers DROP COLUMN IF EXISTS bank_address;
