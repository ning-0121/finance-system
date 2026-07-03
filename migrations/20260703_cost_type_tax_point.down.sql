-- 回滚：移除 tax_point 类型（先把已录的票点行改回 other，否则约束加不上）
UPDATE public.cost_items SET cost_type = 'other' WHERE cost_type = 'tax_point';
ALTER TABLE public.cost_items DROP CONSTRAINT IF EXISTS cost_items_cost_type_check;
ALTER TABLE public.cost_items ADD CONSTRAINT cost_items_cost_type_check
  CHECK (cost_type IN ('fabric', 'accessory', 'processing', 'freight', 'container', 'logistics', 'commission', 'customs', 'procurement', 'other'));
