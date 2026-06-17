-- 回滚 月结中心增强
ALTER TABLE public.accounting_periods DROP COLUMN IF EXISTS reopen_reason;
ALTER TABLE public.accounting_periods DROP COLUMN IF EXISTS reopen_requested_at;
ALTER TABLE public.accounting_periods DROP COLUMN IF EXISTS reopen_requested_by;
DROP TABLE IF EXISTS public.month_end_snapshots;
