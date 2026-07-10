-- 回滚 20260710_budget_shipping_invoice.sql
ALTER TABLE public.budget_orders
  DROP COLUMN IF EXISTS shipping_invoice;
