-- ========================================================================
-- 20260712 统一应付口径 3a:payable_records / cost_items 加 dedup_key(供应商+订单+金额+币种)
-- ========================================================================
-- 老板 2026-07-12 决策 D1:应付双流(cost_items 决算流 vs payable_records 采购付款流)合一,
--   去重键 = 供应商 + 订单 + 金额。本迁移只建键(3b 才用它去重/归集)。
-- 用【生成列 generated always ... stored】:永远自动算、历史行自动回填、无需应用代码维护;
--   币种一并入键,防「¥3000 与 $3000 同数字」被误判为同一笔。
-- 口径:coalesce(小写去空格供应商,'') | 订单id | round(金额,2) | 大写币种
-- 纯增量、可回滚(drop column)。生成 stored 列会重写表一次(财务表数据量小,快);⚠️ 人工在财务库执行。
-- ========================================================================

alter table public.payable_records
  add column if not exists dedup_key text generated always as (
    coalesce(lower(trim(supplier_name)), '') || '|' ||
    coalesce(budget_order_id::text, '')       || '|' ||
    round(amount, 2)::text                     || '|' ||
    coalesce(upper(currency), '')
  ) stored;

alter table public.cost_items
  add column if not exists dedup_key text generated always as (
    coalesce(lower(trim(supplier)), '')  || '|' ||
    coalesce(budget_order_id::text, '')  || '|' ||
    round(amount, 2)::text                || '|' ||
    coalesce(upper(currency), '')
  ) stored;

create index if not exists idx_payable_records_dedup on public.payable_records(dedup_key);
create index if not exists idx_cost_items_dedup       on public.cost_items(dedup_key);

comment on column public.payable_records.dedup_key is
  '统一应付去重键=供应商|订单|金额|币种(生成列,自动维护)。决算派生应付前按它跳过已存在应付,防双流重复(D1)。';
comment on column public.cost_items.dedup_key is
  '同 payable_records.dedup_key 口径;采购对账成本↔应付按它对齐(D1)。';

-- 验证(期望两列都在、能看到已回填的键):
--   select dedup_key from public.payable_records where deleted_at is null limit 5;
--   select dedup_key from public.cost_items limit 5;
