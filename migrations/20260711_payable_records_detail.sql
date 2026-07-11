-- ========================================================================
-- payable_records.detail(2026-07-11 · P2 采购付款→财务应付)
-- ========================================================================
-- 采购对账付款申请入账(payable.created)时,把「采购订单明细 ↔ 供应商对账明细」逐行快照
--   存进 detail.lines,供付款审批页两栏核对(数量/单价/金额差异高亮)。
-- source_ref 列已在 20260711_payable_records_source_ref.sql(已跑 PASS)。
-- 纯加法,手工应付 detail 默认 '{}'。⚠️ 财务库 qpoboelobqnfbytugzkw 执行。
-- ========================================================================
ALTER TABLE public.payable_records
  ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.payable_records.detail IS
  '外部来源明细:采购对账付款存 { lines[], order_refs[], reconciliation_id, purchase_order_id }。lines 每行含采购订单数量/单价/金额 + 供应商对账数量/金额,供付款审批核对。';

-- 验证:SELECT column_name FROM information_schema.columns
--   WHERE table_name='payable_records' AND column_name='detail';   -- 期望 1 行
