-- 回滚:采购单驳回重提留痕(20260731_po_resubmit_reopen)
-- ⚠️ 注意:删列会一并丢掉历次审批决定的归档留痕。若已有重提发生过,
--   建议先导出备查:
--     SELECT po_no, approval_history FROM public.fin_purchase_orders
--      WHERE jsonb_array_length(approval_history) > 0;

ALTER TABLE public.fin_purchase_orders DROP COLUMN IF EXISTS approval_history;
