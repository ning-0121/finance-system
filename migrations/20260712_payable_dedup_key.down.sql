-- 回滚 20260712_payable_dedup_key
drop index if exists public.idx_payable_records_dedup;
drop index if exists public.idx_cost_items_dedup;
alter table public.payable_records drop column if exists dedup_key;
alter table public.cost_items       drop column if exists dedup_key;
