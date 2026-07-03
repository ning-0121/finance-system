-- ============================================================
-- 新增费用类型：tax_point（票点）
-- 业务规则(老板决策)：票点是供应商开票费用，用于将来与出口退税核算——
--   不计入订单预算/决算/毛利/GL成本结转；仍计入应付与供应商对账(确实欠款)。
-- 本迁移仅扩展 CHECK 约束；排除逻辑在应用层(决算/核算单/毛利表/预算总表/GL)。
-- 可加可逆（回滚见 .down.sql；回滚前需先把 tax_point 行改回 other）。
-- ============================================================
ALTER TABLE public.cost_items DROP CONSTRAINT IF EXISTS cost_items_cost_type_check;
ALTER TABLE public.cost_items ADD CONSTRAINT cost_items_cost_type_check
  CHECK (cost_type IN ('fabric', 'accessory', 'processing', 'freight', 'container', 'logistics', 'commission', 'customs', 'procurement', 'other', 'tax_point'));
