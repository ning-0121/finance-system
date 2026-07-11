-- ============================================================
-- 所有采购单一律须财务审批(取消 ¥5000 门槛)· 存量 pending → pending_approval
--
-- 业务规则(老板 2026-07-11):此前只有 ≥¥5000 且节拍器发 approval_requested 的采购单才进
--   「采购审批」队列,其余以 fin_status='pending' 落库 —— 结果绝大多数采购单只出现在
--   「费用归集/采购单工作台」,采购审批页长期为空(用户反馈:采购申请显示不了)。
--   现改为所有采购单都须审批:收单一律置 pending_approval(见 webhook handlePurchaseOrderPlaced)。
--
-- 本迁移把【存量】仍卡在 pending 的采购单迁到 pending_approval,使其立刻显示到采购审批页。
--   只动未决的 pending;registered/ignored/approved/rejected/已删 一律不碰。
-- 纯数据迁移、可逆(见 .down.sql)。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
UPDATE public.fin_purchase_orders
   SET fin_status = 'pending_approval',
       requires_approval = true,
       updated_at = now()
 WHERE fin_status = 'pending'
   AND deleted_at IS NULL;

-- 自验证:迁移后不应再有 deleted_at IS NULL 的 pending 采购单
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.fin_purchase_orders
    WHERE fin_status = 'pending' AND deleted_at IS NULL;
  IF v > 0 THEN RAISE EXCEPTION '仍有 % 张 pending 采购单未迁移', v; END IF;
  RAISE NOTICE '✓ 存量 pending 采购单已全部迁至 pending_approval';
END $$;
