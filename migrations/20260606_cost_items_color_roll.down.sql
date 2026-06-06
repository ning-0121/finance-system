-- 回滚 费用明细 颜色/匹数 字段
ALTER TABLE public.cost_items DROP COLUMN IF EXISTS color;
ALTER TABLE public.cost_items DROP COLUMN IF EXISTS roll_count;
