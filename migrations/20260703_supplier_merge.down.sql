-- 回滚：供应商归并基础设施
-- 注意：已执行过的归并(历史数据改名)不可自动回退——审计时间线
-- (event_type='supplier_merged')里有逐次归并的表级计数与别名清单，可据此人工修复。
DROP FUNCTION IF EXISTS public.merge_supplier_names(text[], text, uuid);
DROP TABLE IF EXISTS public.supplier_aliases;
