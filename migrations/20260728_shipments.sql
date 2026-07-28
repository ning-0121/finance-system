-- ============================================================
-- 出运票级建模(功能2,2026-07-28 老板拍板):每一票货 = 一张提单;
--   一单可多票、多单可合并一票 → 订单↔票 多对多。
--
-- 1) shipments        一票一行(提单号/CI号/港口/ETD),幂等键 source_ref=节拍器 shipment id
-- 2) shipment_orders  票↔订单 链接表(多对多;冗余 order_no/internal 便于展示,budget_order_id 解析后回填)
-- 3) uploaded_documents 加 related_shipment_id —— 提单/CI 文件挂到票上(节拍器 shipment.recorded 推送)
--
-- RLS 与核心财务表同口径(读=登录,写=财务角色,删=财务主管);webhook 用 service client 绕 RLS 入库。
-- 可加可逆,回滚见 .down.sql。⚠️ 财务库执行。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.shipments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_ref       text,                                  -- 幂等键(节拍器 shipment id / request_id)
  bl_no            text,                                  -- 提单号
  ci_no            text,                                  -- 商业发票号
  shipping_port    text,
  destination_port text,
  etd              date,
  carton_count     integer,
  status           text NOT NULL DEFAULT 'shipped' CHECK (status IN ('shipped','arrived','closed','cancelled')),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_source_ref
  ON public.shipments (source_ref) WHERE source_ref IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipments_bl ON public.shipments (bl_no);

CREATE TABLE IF NOT EXISTS public.shipment_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id       uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  qimo_order_id     uuid,                                 -- 节拍器订单 id(= synced_orders.id)
  order_no          text,                                 -- QM-xxx(冗余展示)
  internal_order_no text,                                 -- 内部款号(冗余展示)
  budget_order_id   uuid REFERENCES public.budget_orders(id),  -- 解析后回填,拿决算/PO附件用
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_orders_uniq
  ON public.shipment_orders (shipment_id, qimo_order_id) WHERE qimo_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_orders_ship ON public.shipment_orders (shipment_id);
CREATE INDEX IF NOT EXISTS idx_shipment_orders_bo   ON public.shipment_orders (budget_order_id);

-- 提单/CI 等文件挂票
ALTER TABLE public.uploaded_documents ADD COLUMN IF NOT EXISTS related_shipment_id uuid;
CREATE INDEX IF NOT EXISTS idx_uploaded_docs_shipment ON public.uploaded_documents (related_shipment_id);

-- RLS(两张新表)
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shipments','shipment_orders'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert_fin', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update_fin', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete_mgr', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (coalesce(public._app_role(),''none'') IN (''finance_staff'',''finance_manager'',''admin''))', t || '_insert_fin', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (coalesce(public._app_role(),''none'') IN (''finance_staff'',''finance_manager'',''admin'')) WITH CHECK (coalesce(public._app_role(),''none'') IN (''finance_staff'',''finance_manager'',''admin''))', t || '_update_fin', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (coalesce(public._app_role(),''none'') IN (''finance_manager'',''admin''))', t || '_delete_mgr', t);
  END LOOP;
END $rls$;

-- 验证:
-- SELECT policyname, cmd FROM pg_policies WHERE tablename IN ('shipments','shipment_orders');
