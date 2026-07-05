-- ============================================================
-- 采购单审批(≥¥5000 需财务审核)· fin_purchase_orders 状态机扩展
--
-- 业务规则(老板 2026-07-05):采购在节拍器下单,单张总额 ≥¥5000 → 节拍器卡住并
--   发 purchase_order.approval_requested → 财务侧本单进「待审批」→ 财务批/驳(审批时看
--   预算对照 + 原辅料历史采购价)→ 回传节拍器放行/拦下。<¥5000 不进此流程。
--
-- fin_status 增 3 态：pending_approval(待财务审批) / approved(已批准) / rejected(已驳回)
--   保留原 pending/registered/ignored(<5000 或已入账的常规采购单仍走老路)。
-- 加审批字段(与 processed_* 分开,审批是「批不批采购」,登记是「入没入账」)。
-- 加法式、可逆(见 .down.sql)。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
ALTER TABLE public.fin_purchase_orders DROP CONSTRAINT IF EXISTS fin_po_fin_status_chk;
ALTER TABLE public.fin_purchase_orders ADD CONSTRAINT fin_po_fin_status_chk
  CHECK (fin_status IN ('pending','registered','ignored','pending_approval','approved','rejected'));

ALTER TABLE public.fin_purchase_orders
  ADD COLUMN IF NOT EXISTS requires_approval  boolean,               -- 是否触发≥¥5000审批(收单时定)
  ADD COLUMN IF NOT EXISTS approval_decided_by  uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS approval_decided_at  timestamptz,
  ADD COLUMN IF NOT EXISTS approval_note        text,                -- 批/驳意见
  ADD COLUMN IF NOT EXISTS approval_callback_at timestamptz;         -- 已回传节拍器的时间(幂等/可见)

CREATE INDEX IF NOT EXISTS idx_fin_po_approval
  ON public.fin_purchase_orders (fin_status) WHERE fin_status = 'pending_approval' AND deleted_at IS NULL;

-- 自验证
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.columns
    WHERE table_name='fin_purchase_orders' AND column_name IN ('requires_approval','approval_decided_by','approval_note');
  IF v < 3 THEN RAISE EXCEPTION 'fin_purchase_orders 审批字段缺失 (count=%)', v; END IF;
  RAISE NOTICE '✓ 采购单审批状态机已就绪(pending_approval/approved/rejected + 审批字段)';
END $$;
