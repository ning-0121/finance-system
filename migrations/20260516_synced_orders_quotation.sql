-- Phase 3 Path A: 节拍器报价 receiver scaffolding
-- 存原始 quotation payload + 抽取标志，方便后续审计 / 补救

ALTER TABLE public.synced_orders
  ADD COLUMN IF NOT EXISTS quotation_data jsonb,
  ADD COLUMN IF NOT EXISTS quotation_applied_at timestamptz;

-- 索引（用于报表：有多少同步订单含报价、何时开始覆盖）
CREATE INDEX IF NOT EXISTS idx_synced_orders_with_quotation
  ON public.synced_orders (quotation_applied_at)
  WHERE quotation_data IS NOT NULL;

DO $$ BEGIN
  RAISE NOTICE '✓ synced_orders.quotation_data + quotation_applied_at 就绪（等节拍器推 quotation 即可生效）';
END $$;
