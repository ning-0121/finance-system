-- 回滚：删除 qimo_order_id 唯一索引
DROP INDEX IF EXISTS public.uniq_budget_orders_qimo_order_id;
