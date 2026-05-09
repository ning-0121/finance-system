-- 应收账款：实际收款金额与时间（订单币种）
ALTER TABLE public.budget_orders
  ADD COLUMN IF NOT EXISTS ar_received_amount numeric(15,2),
  ADD COLUMN IF NOT EXISTS ar_received_at timestamptz;

COMMENT ON COLUMN public.budget_orders.ar_received_amount IS '实际收款金额（订单币种）；优先于「已关闭」推断';
COMMENT ON COLUMN public.budget_orders.ar_received_at IS '实际收款日期时间';
