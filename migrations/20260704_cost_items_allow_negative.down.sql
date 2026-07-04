-- 回滚：恢复 cost_items 金额非负约束
-- 注意：若此时库中已存在负金额行，本回滚会失败（需先清理负行）。
ALTER TABLE public.cost_items
  ADD CONSTRAINT chk_cost_amount_non_negative CHECK (amount >= 0);
