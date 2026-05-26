-- 决算单核算单(图片格式)所需字段补全
-- 1. cost_items 增 quantity / unit / unit_price 列（图片支区每行需要展示）
-- 2. budget_orders 增 product_name（图片头部"品名"行）
-- 3. cost_items 增 cost_group 用于跨 cost_type 的人工分组（如多张吊牌归并到"吊卡"组）

ALTER TABLE public.cost_items
  ADD COLUMN IF NOT EXISTS quantity   numeric(18,4),
  ADD COLUMN IF NOT EXISTS unit       text,
  ADD COLUMN IF NOT EXISTS unit_price numeric(18,4),
  ADD COLUMN IF NOT EXISTS cost_group text;

ALTER TABLE public.budget_orders
  ADD COLUMN IF NOT EXISTS product_name text;

-- 索引：导出时频繁按 (budget_order_id, cost_group, supplier) 排序聚合
CREATE INDEX IF NOT EXISTS idx_cost_items_group_supplier
  ON public.cost_items (budget_order_id, cost_group, supplier)
  WHERE deleted_at IS NULL;

DO $$ BEGIN
  RAISE NOTICE '✓ Settlement export columns ready: cost_items.{quantity,unit,unit_price,cost_group} + budget_orders.product_name';
END $$;
