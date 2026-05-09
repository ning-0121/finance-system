-- ============================================================
-- 回滚：移除 budget_orders 上的应收登记字段
-- ============================================================
-- 注意：执行前需先确认这些字段没有被业务数据填充。
--   如果已填，请先备份 ar_received_amount / ar_received_at 数据。
-- ============================================================

ALTER TABLE public.budget_orders
  DROP COLUMN IF EXISTS ar_received_amount,
  DROP COLUMN IF EXISTS ar_received_at;
