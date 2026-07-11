-- ========================================================================
-- payable_records.source_ref(2026-07-11)—— 采购付款申请外部引用锚
-- ========================================================================
-- 背景:节拍器(order-metronome)采购对账确认后,采购分批(每周·自定义金额)提交付款申请,
--   走新入站事件 payable.created 建 payable_records(=付款申请)。需要一个外部引用列把这条应付
--   锚回节拍器的付款申请 id,以便:① 入站幂等(同一付款申请重发不重复建)② 出纳付完 payment.completed
--   回带 source_ref,让节拍器累加对账 paid_amount。
-- 幂等:局部唯一索引(source_ref 非空且未删)——仿 20260702_supplier_payment_source_idempotency。
-- 纯加法,不影响手工付款申请(source_ref 为 NULL)。⚠️ 人工在财务 Supabase 执行。
-- ========================================================================

ALTER TABLE public.payable_records
  ADD COLUMN IF NOT EXISTS source_ref text;

COMMENT ON COLUMN public.payable_records.source_ref IS
  '外部来源引用(节拍器采购付款申请 id);payable.created 入站幂等 + payment.completed 回带节拍器累加对账已付。手工付款申请为 NULL。';

CREATE UNIQUE INDEX IF NOT EXISTS payable_records_source_ref_uniq
  ON public.payable_records (source_ref)
  WHERE source_ref IS NOT NULL AND deleted_at IS NULL;

-- ========================================================================
-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='payable_records' AND column_name='source_ref';   -- 期望 1 行
--   SELECT indexname FROM pg_indexes WHERE indexname='payable_records_source_ref_uniq';  -- 期望 1 行
-- ========================================================================
