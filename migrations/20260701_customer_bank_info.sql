-- ============================================================
-- 收款信息维护：客户银行信息字段（命名对齐 suppliers）
--  - account_name  户名
--  - account_no    银行账号 / IBAN
--  - bank_name     开户行
--  - swift_code    SWIFT/BIC（外贸客户电汇用）
--  - bank_address  银行地址（外贸客户电汇用）
-- 均为可空补充列，可加可逆（回滚见 .down.sql）。
-- ============================================================
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS account_name text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS account_no text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS bank_name text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS swift_code text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS bank_address text;
