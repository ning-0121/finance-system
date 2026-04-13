-- 修复cost_items的cost_type CHECK约束
-- 原约束只允许5种，需要扩展为10种行业术语

-- 先删除旧约束
ALTER TABLE public.cost_items DROP CONSTRAINT IF EXISTS cost_items_cost_type_check;

-- 添加新约束（包含所有10种费用类型）
ALTER TABLE public.cost_items ADD CONSTRAINT cost_items_cost_type_check
  CHECK (cost_type IN ('fabric', 'accessory', 'processing', 'freight', 'container', 'logistics', 'commission', 'customs', 'procurement', 'other'));
