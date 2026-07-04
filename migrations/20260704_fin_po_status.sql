-- ============================================================
-- 采购单工作台：财务侧处理状态
--  fin_status: pending(待处理) / registered(已登记为费用) / ignored(已忽略)
--  财务角色可更新处理状态(此前该表只有 service_role 可写)
-- 可加可逆（回滚见 .down.sql）
-- ============================================================
ALTER TABLE public.fin_purchase_orders ADD COLUMN IF NOT EXISTS fin_status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.fin_purchase_orders DROP CONSTRAINT IF EXISTS fin_po_fin_status_chk;
ALTER TABLE public.fin_purchase_orders ADD CONSTRAINT fin_po_fin_status_chk
  CHECK (fin_status IN ('pending','registered','ignored'));
ALTER TABLE public.fin_purchase_orders ADD COLUMN IF NOT EXISTS processed_at timestamptz;
ALTER TABLE public.fin_purchase_orders ADD COLUMN IF NOT EXISTS processed_by uuid REFERENCES public.profiles(id);

DROP POLICY IF EXISTS fin_po_update_fin ON public.fin_purchase_orders;
CREATE POLICY fin_po_update_fin ON public.fin_purchase_orders
  FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
