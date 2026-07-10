-- 回滚 P0-3b:payable_records.exchange_rate(删触发器+函数+列)
DROP TRIGGER IF EXISTS trg_fill_payable_exchange_rate ON public.payable_records;
DROP FUNCTION IF EXISTS public.fill_payable_exchange_rate();
ALTER TABLE public.payable_records DROP COLUMN IF EXISTS exchange_rate;
