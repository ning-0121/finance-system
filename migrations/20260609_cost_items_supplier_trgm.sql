-- ============================================================
-- 性能：cost_items.supplier 三元组索引
-- 供应商应付「独立深链页」(/payables/[supplier]) 用 ILIKE '%名称%' 取该供应商费用，
-- 无索引时全表扫描。加 pg_trgm GIN 索引让 ILIKE 走索引。
-- （应付工作台路径已「零再请求」，此项仅优化深链页大数据量场景。）
-- 可加可逆。回滚见 20260609_cost_items_supplier_trgm.down.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_cost_items_supplier_trgm
  ON public.cost_items USING gin (supplier gin_trgm_ops);

-- 验证：
-- EXPLAIN SELECT * FROM cost_items WHERE supplier ILIKE '%华航%';  -- 应见 Bitmap Index Scan on idx_cost_items_supplier_trgm
