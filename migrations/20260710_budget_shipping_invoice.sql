-- ============================================================
-- 20260710 出货发票(CI)→ 应收快照列
-- 节拍器出运完成时推 shipping_invoice.issued(累计各批 CI 金额)。
-- draft 预算单据 → 以 CI 金额更新 total_revenue(应收);
-- 已确认(approved 等)→ 只记 integration_logs 告警,不改账。
-- 本列只存 CI 快照(金额/币种/定金/各批明细/收报时间),供审计与「已确认差异」比对,
-- 不参与任何账务计算(账务口径仍是 total_revenue)。可加可逆,down 见同名 .down.sql。
-- ============================================================

ALTER TABLE public.budget_orders
  ADD COLUMN IF NOT EXISTS shipping_invoice jsonb;

COMMENT ON COLUMN public.budget_orders.shipping_invoice IS
  '节拍器出货发票(CI)快照:{ invoice_amount, currency, deposit_raw, invoice_qty, scopes[], booked(bool 是否已据此更新应收), prev_total_revenue, received_at, source }。draft 时据 invoice_amount 更新 total_revenue;已确认只存快照+告警不改账。';
