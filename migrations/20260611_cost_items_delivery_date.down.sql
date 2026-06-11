-- 回滚 费用送货日期列
ALTER TABLE public.cost_items DROP COLUMN IF EXISTS delivery_date;
