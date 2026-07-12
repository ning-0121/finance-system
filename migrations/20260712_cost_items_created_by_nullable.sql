-- 20260712 统一应付 3b-2:cost_items.created_by 放开 NOT NULL(允许系统同步来源)
-- 采购对账付款经 webhook 归集 cost_items 时是系统上下文、无登录人,与既有「系统同步 created_by=null」
--   口径一致(budget_orders draft、payable_records 等系统同步行同样 created_by=null)。
-- 系统来源靠 source_module='procurement_reconciliation' 标识,非靠 created_by。
-- 纯增量、可回滚(re-add NOT NULL 需先回填 created_by)。⚠️ 人工在财务库执行。
alter table public.cost_items alter column created_by drop not null;
comment on column public.cost_items.created_by is
  '手工/导入=真实登录人;系统同步(采购对账归集等,source_module 标识)=null。';
