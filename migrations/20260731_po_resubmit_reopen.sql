-- ============================================================
-- 采购单驳回后重新提交 → 重新进入财务审批队列(2026-07-31)
--
-- 问题(生产实证):采购单被财务驳回后,采购改好价格在节拍器【重新提交】,
--   节拍器侧显示「待审批」,财务侧却永远看不到 —— 采购和财务各看各的,单子卡死。
--   根因在 webhook handlePurchaseOrderPlaced:
--     const gated = !cur || cur === 'pending'      // rejected 不在其中
--   重提事件把金额/供应商/placed_at 都更新了,唯独 fin_status 仍是 'rejected',
--   而审批队列查的是 fin_status='pending_approval' → 该单再也不出现。
--   该守卫本意是防「inbox 重投」把已批的单打回待审,但重投在上游已有
--   request_id 唯一约束去重;它误伤的是「驳回→整改→重提」这条正常业务路径。
--
-- 本迁移:加 approval_history jsonb —— 重开时把上一次的批/驳决定归档进来,
--   否则重开会直接覆盖 approval_decided_by/at/note,审批留痕丢失(财务合规不允许)。
--   同时财务重审时能看到「这是第 N 次提交,上次驳回理由是 X」,避免重复踩坑。
--
-- 结构:[{ decision, note, decided_by, decided_at, superseded_at, superseded_by_request }]
-- 纯可加可逆(只加一列,默认空数组,不改既有数据/状态)。回滚见 .down.sql。
-- ⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================

ALTER TABLE public.fin_purchase_orders
  ADD COLUMN IF NOT EXISTS approval_history jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.fin_purchase_orders.approval_history IS
  '历次审批决定归档(驳回→重提时把上一次决定压入)。当前决定仍在 approval_decided_* 列。';

-- 自验证
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.columns
    WHERE table_name='fin_purchase_orders' AND column_name='approval_history';
  IF v <> 1 THEN RAISE EXCEPTION 'approval_history 列未建成 (count=%)', v; END IF;
  RAISE NOTICE '✓ fin_purchase_orders.approval_history 已就绪(驳回重提可归档留痕)';
END $$;
