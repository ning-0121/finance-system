-- 20260711 payable_records 加 delivery_date(送货日期)——纯增量、可回滚。
-- 用途:按供应商汇总里「按送货月归集」(供应商按月送货结款场景)。
-- 与 due_date(付款/账期日期)区分:delivery_date=货实际送到的日期,决定归到哪个月的应付。
-- 来源:① 新增付款申请表单手填;② 决算按 cost_items 生成应付时,填该组最晚 delivery_date。
-- 不回填历史(留 null → 汇总按送货月分组时缺失者退回 due_date,不丢)。
-- 回滚:alter table public.payable_records drop column if exists delivery_date;

alter table public.payable_records
  add column if not exists delivery_date date;

comment on column public.payable_records.delivery_date is
  '送货日期(货实际到货日)。用于「按送货月」归集应付。与 due_date(付款/账期日)区分。';
