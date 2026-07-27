-- ============================================================
-- 杂项/独立应收表 misc_receivables(2026-07-27:节拍器 receivable.created 契约落地)
--
-- 背景:节拍器推「打样费」等【不挂订单总收入】的独立应收(event=receivable.created),
--   财务的既有应收是订单中心的(budget_orders.total_revenue + 1122 + receivable_payments),
--   这类杂项应收没有家。本表对称于 payable_records:客户/金额/币种/类型/关联单号/状态/幂等键。
--   webhook 入站建 open 应收;收款时置 received + 回传节拍器 collection.received 闭环。
--
-- 幂等:source_ref(= webhook request_id)唯一(软删感知)。
-- RLS:与核心财务表同口径(20260611)——读=登录,写=财务角色,删=财务主管;
--   webhook 用 service client 绕 RLS 入库,UI 走登录会话受角色约束。
-- 可加可逆,回滚见 .down.sql。⚠️ 财务库执行。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.misc_receivables (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_ref        text,                                    -- 幂等键(= webhook request_id)
  kind              text NOT NULL DEFAULT 'sample_fee',      -- 打样费等
  customer_name     text NOT NULL,
  customer_id       uuid REFERENCES public.customers(id),
  qimo_order_id     text,
  order_no          text,
  internal_order_no text,
  amount            numeric(15,2) NOT NULL CHECK (amount >= 0),
  currency          text NOT NULL DEFAULT 'CNY',
  bearer            text,                                    -- 承担方(customer 等)
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','received','cancelled')),
  received_amount   numeric(15,2),
  received_at       timestamptz,
  notes             text,
  created_by        uuid REFERENCES public.profiles(id),     -- webhook 建=null;收款时记真实审批人
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);

-- 幂等唯一(软删感知):同 request_id 重投不重复建
CREATE UNIQUE INDEX IF NOT EXISTS idx_misc_receivables_source_ref
  ON public.misc_receivables (source_ref) WHERE source_ref IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_misc_receivables_status ON public.misc_receivables (status, created_at);

ALTER TABLE public.misc_receivables ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS misc_receivables_read       ON public.misc_receivables;
DROP POLICY IF EXISTS misc_receivables_insert_fin ON public.misc_receivables;
DROP POLICY IF EXISTS misc_receivables_update_fin ON public.misc_receivables;
DROP POLICY IF EXISTS misc_receivables_delete_mgr ON public.misc_receivables;
CREATE POLICY misc_receivables_read ON public.misc_receivables
  FOR SELECT TO authenticated USING (true);
CREATE POLICY misc_receivables_insert_fin ON public.misc_receivables
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY misc_receivables_update_fin ON public.misc_receivables
  FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY misc_receivables_delete_mgr ON public.misc_receivables
  FOR DELETE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- 验证:
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='misc_receivables';
-- SELECT * FROM public.misc_receivables ORDER BY created_at DESC LIMIT 5;
