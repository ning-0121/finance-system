-- 回滚:删除作废审批单表(及其索引/触发器/策略随表一并删除)。
DROP TABLE IF EXISTS public.order_void_requests CASCADE;
