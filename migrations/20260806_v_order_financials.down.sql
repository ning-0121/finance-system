-- 回滚:订单财务口径视图(20260806_v_order_financials)
-- 只读视图,删除不影响任何底表数据;删后报表页会退回前端全量聚合。
DROP VIEW IF EXISTS public.v_order_financials;
