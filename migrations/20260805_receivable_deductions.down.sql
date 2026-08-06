-- 回滚:客户扣款(20260805_receivable_deductions)
-- ⚠️ 删表会丢掉全部扣款记录,应收余额会因此虚增(扣款不再被减掉)。
-- 回滚前先导出备查:
--   SELECT budget_order_id, customer_name, amount_cny, deduction_type, treatment, reason, occurred_at
--     FROM public.receivable_deductions WHERE voided_at IS NULL;
DROP INDEX IF EXISTS public.idx_recv_deductions_order;
DROP INDEX IF EXISTS public.idx_recv_deductions_customer;
DROP TABLE IF EXISTS public.receivable_deductions;
