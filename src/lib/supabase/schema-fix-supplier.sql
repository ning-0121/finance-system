-- 给cost_items表添加supplier列（供应商名称，用于按供应商汇总对账）
ALTER TABLE public.cost_items ADD COLUMN IF NOT EXISTS supplier text;
CREATE INDEX IF NOT EXISTS idx_cost_items_supplier ON public.cost_items(supplier);
