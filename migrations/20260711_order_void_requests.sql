-- ============================================================
-- 订单作废审批单 order_void_requests(问题2 · 切片2)
--
-- 业务(老板 2026-07-11):删/取消订单不硬删。发起作废 → 体检分三级 → 财务经理终审 →
--   级联软删(可恢复)。手工发起(创建人/财务)与节拍器 order.cancelled 汇入同一队列。
--   本表 = 作废审批单:记发起人/原因/体检快照(blockers)/终审人/级联结果。
--   分级见 src/lib/financial/order-void.ts;终审+级联软删见切片3;节拍器兜底见切片4。
-- 加法式、可逆(见 .down.sql)。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.order_void_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_order_id uuid NOT NULL REFERENCES public.budget_orders(id),
  order_no       text,                    -- BO 号快照(便于列表展示,订单删了也可读)
  qm_order_no    text,                    -- 节拍器号快照
  internal_no    text,                    -- 内部单号/款号快照
  source         text NOT NULL DEFAULT 'finance' CHECK (source IN ('finance','creator','metronome')),
  reason         text NOT NULL,           -- 作废原因(必填)
  severity       text NOT NULL CHECK (severity IN ('clean','has_approved','blocked_admin')),
  blockers       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 体检快照 VoidItem[](发起时刻)
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by   uuid REFERENCES public.profiles(id),  -- 真实发起人(auth.uid)
  requested_by_name text,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES public.profiles(id),  -- 真实终审人(切片3)
  decider_name   text,
  decision_note  text,
  decided_at     timestamptz,
  cascade_result jsonb,                    -- 级联软删结果(切片3 留痕/恢复依据)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- 一个订单同一时刻只允许一个未决作废申请(幂等、防重复发起)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_void_pending
  ON public.order_void_requests (budget_order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_order_void_status
  ON public.order_void_requests (status, requested_at);

-- updated_at 自动维护(复用既有触发器函数)
DROP TRIGGER IF EXISTS trg_order_void_updated_at ON public.order_void_requests;
CREATE TRIGGER trg_order_void_updated_at BEFORE UPDATE ON public.order_void_requests
  FOR EACH ROW EXECUTE PROCEDURE public.update_updated_at();

-- RLS:读对登录放开;写走服务端路由(service_role 绕过 RLS,角色校验在 API 层 requireRole)。
-- 与既有财务表口径一致(select/insert/update TO authenticated)。
ALTER TABLE public.order_void_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_void_sel ON public.order_void_requests;
DROP POLICY IF EXISTS order_void_ins ON public.order_void_requests;
DROP POLICY IF EXISTS order_void_upd ON public.order_void_requests;
CREATE POLICY order_void_sel ON public.order_void_requests FOR SELECT TO authenticated USING (true);
CREATE POLICY order_void_ins ON public.order_void_requests FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY order_void_upd ON public.order_void_requests FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- 自验证
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.tables WHERE table_name = 'order_void_requests';
  IF v < 1 THEN RAISE EXCEPTION 'order_void_requests 建表失败'; END IF;
  RAISE NOTICE '✓ order_void_requests 已就绪(作废审批单)';
END $$;
