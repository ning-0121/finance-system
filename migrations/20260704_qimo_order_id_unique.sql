-- ============================================================
-- P1：budget_orders.qimo_order_id 部分唯一索引（防同一绮陌订单重复建单）
-- 背景(审计 P1)：qimo_order_id 此前只加列不接线、全空，联通靠 synced_orders 中转+notes。
--   已回填 147 单(=synced_orders.id)，webhook/sync 建单也已补 qimo_order_id: order.id。
--   加唯一索引后，同一绮陌订单在 DB 层无法被建成两张 budget_order。
-- 部分索引：仅对 非空 且 未软删 生效（软删/历史无绮陌单不受约束）。可加可逆。
-- 前置：已确认现存数据 qimo_order_id 无重复。
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS uniq_budget_orders_qimo_order_id
  ON public.budget_orders (qimo_order_id)
  WHERE qimo_order_id IS NOT NULL AND deleted_at IS NULL;
