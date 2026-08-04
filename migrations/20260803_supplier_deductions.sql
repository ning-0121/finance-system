-- ============================================================
-- 供应商待扣款 supplier_deductions(2026-08-03 老板决策:事件驱动锁死工厂扣款)
--
-- 问题:工厂扣款靠人记得登记 —— 圆圆漏登几笔共 ¥1500,财务对账时无从发现,
--   因为「本该有但没登记」这件事系统压根不知道。加个"请确认有无扣款"的勾选
--   只能防"忘了填",防不了"不知道有"。
--
-- 老板洞察:工厂扣款【一定由上游事件引发】—— 验货不合格、补原辅料、返工。
--   所以正确做法是把因果链锁上:
--     事件发生 → 系统自动建「待扣款」→ 对账/付款时未处理就卡住
--   让"忘记"在结构上不可能:系统【先于人】知道该扣钱。
--
-- 本表 = 待扣款台账。一条 = 一个应扣事件。
--   status: pending(待处理) → applied(已在对账中扣除) / waived(经审批豁免) / cancelled(事件撤销)
--   ⚠️ applied/waived 必须记真实 auth.uid()(铁律:AI/系统不得自主核销财务事项)。
--
-- 幂等:source_ref(= webhook request_id)唯一,节拍器重投不重复建。
-- RLS 同核心财务表口径(20260611):读=登录,写=财务角色,删=财务主管。
-- 可加可逆,回滚见 .down.sql。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.supplier_deductions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_ref        text UNIQUE,                              -- 幂等键(= webhook request_id)
  -- 触发事件:这是本表存在的意义,必须能追回是哪件事引起的扣款
  event_type        text NOT NULL CHECK (event_type IN ('qc_failed','material_resupplied','rework','manual')),
  event_ref         text,                                     -- 节拍器侧事件/单据 id(验货单号、补料单号…)
  occurred_at       timestamptz,                              -- 事件发生时间(非入库时间)
  -- 责任对象
  supplier_id       uuid REFERENCES public.suppliers(id),
  supplier_name     text NOT NULL,
  qimo_order_id     text,
  order_no          text,
  internal_order_no text,
  purchase_order_no text,                                     -- 关联采购单(若事件能定位到)
  -- 金额:节拍器给建议值,财务可改;币种随采购单
  amount            numeric(15,2) NOT NULL CHECK (amount >= 0),
  currency          text NOT NULL DEFAULT 'CNY',
  reason            text,                                     -- 扣款事由(验货不合格明细、补料清单…)
  detail            jsonb,                                    -- 事件原始明细(数量/批次/责任判定)
  -- 处理状态
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','applied','waived','cancelled')),
  applied_at        timestamptz,
  applied_by        uuid REFERENCES public.profiles(id),      -- 真实审批人,不信任客户端传入
  applied_payable_id uuid REFERENCES public.payable_records(id),  -- 在哪张应付/对账单里扣的
  waived_reason     text,                                     -- 豁免必须写理由(不能默默放过)
  notes             text,
  created_by        uuid REFERENCES public.profiles(id),      -- webhook 入库=null
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  deleted_by        uuid REFERENCES public.profiles(id),
  delete_reason     text
);

-- 付款闸门要按「供应商 + 待处理」秒查,故建局部索引
CREATE INDEX IF NOT EXISTS idx_supplier_deductions_pending
  ON public.supplier_deductions (supplier_name, status)
  WHERE status = 'pending' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_deductions_order
  ON public.supplier_deductions (qimo_order_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_deductions_po
  ON public.supplier_deductions (purchase_order_no) WHERE deleted_at IS NULL;

-- 豁免必须有理由;已处理必须有处理人(防"系统自己核销")
ALTER TABLE public.supplier_deductions DROP CONSTRAINT IF EXISTS supplier_deductions_resolution_chk;
ALTER TABLE public.supplier_deductions ADD CONSTRAINT supplier_deductions_resolution_chk CHECK (
  (status <> 'waived'  OR (waived_reason IS NOT NULL AND applied_by IS NOT NULL))
  AND (status <> 'applied' OR applied_by IS NOT NULL)
);

ALTER TABLE public.supplier_deductions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_deductions_read ON public.supplier_deductions;
CREATE POLICY supplier_deductions_read ON public.supplier_deductions
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS supplier_deductions_write ON public.supplier_deductions;
CREATE POLICY supplier_deductions_write ON public.supplier_deductions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
                 AND p.role IN ('finance','finance_manager','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
                 AND p.role IN ('finance','finance_manager','admin')));

-- 自验证
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.columns
    WHERE table_name='supplier_deductions' AND column_name IN ('event_type','supplier_name','amount','status');
  IF v < 4 THEN RAISE EXCEPTION 'supplier_deductions 关键列缺失 (count=%)', v; END IF;
  RAISE NOTICE '✓ supplier_deductions 已就绪(事件驱动待扣款台账)';
END $$;
