-- 回滚：银行日记账
DROP TABLE IF EXISTS public.bank_journal_manual;
DROP INDEX IF EXISTS public.idx_recv_pay_bank_account;
DROP INDEX IF EXISTS public.idx_supp_pay_bank_account;
ALTER TABLE public.receivable_payments DROP COLUMN IF EXISTS bank_account_id;
ALTER TABLE public.supplier_payments   DROP COLUMN IF EXISTS bank_account_id;
ALTER TABLE public.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_account_type_chk;
ALTER TABLE public.bank_accounts DROP COLUMN IF EXISTS account_type;
ALTER TABLE public.bank_accounts DROP COLUMN IF EXISTS opening_balance;
ALTER TABLE public.bank_accounts DROP COLUMN IF EXISTS opening_date;
