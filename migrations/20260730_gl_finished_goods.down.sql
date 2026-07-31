-- 回滚:采购成品独立科目(20260730_gl_finished_goods)
-- ⚠️ 回滚前置(否则会失败或留下悬挂引用):
--   1) 先把费用归集行改回 procurement:
--        UPDATE public.cost_items SET cost_type='procurement' WHERE cost_type='finished_goods';
--   2) 确认没有已过账凭证行挂在 540104(journal_lines.account_code 有外键):
--        SELECT count(*) FROM public.journal_lines WHERE account_code='540104';
--      若 >0,不要删科目——改为停用即可:
--        UPDATE public.accounts SET is_active=false WHERE account_code='540104';

ALTER TABLE public.cost_items DROP CONSTRAINT IF EXISTS cost_items_cost_type_check;
ALTER TABLE public.cost_items ADD CONSTRAINT cost_items_cost_type_check
  CHECK (cost_type IN ('fabric', 'accessory', 'processing', 'freight', 'container', 'logistics', 'commission', 'customs', 'procurement', 'other', 'tax_point'));

DELETE FROM public.accounts WHERE account_code = '540104';
