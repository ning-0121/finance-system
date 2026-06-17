-- ============================================================
-- 出口退税台账（外贸企业「免退税」办法）
-- 应退税额 = 采购增值税专票不含税金额 × 出口退税率（服装常见 13%）。
-- 跟踪：报关出口 → 单证齐全 → 申报 → 退税到账。应退/已退/未退一目了然。
-- 退税额自动算但可手工覆盖（refundable_amount 可改），不做黑盒。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tax_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_order_id uuid REFERENCES public.budget_orders(id),  -- 关联订单（可空，支持独立录入）
  customs_no text,                          -- 报关单号
  export_date date,                         -- 出口日期
  product_name text,                        -- 品名
  fob_usd numeric(15,2),                    -- FOB 出口额（美元）
  exchange_rate numeric(10,4),              -- 折算汇率
  fob_cny numeric(15,2),                    -- FOB 折人民币（参考）
  input_invoice_amount numeric(15,2) NOT NULL DEFAULT 0,  -- 采购增值税专票不含税金额（退税计税基础）
  refund_rate numeric(5,2) NOT NULL DEFAULT 13,           -- 出口退税率 %
  refundable_amount numeric(15,2) NOT NULL DEFAULT 0,     -- 应退税额（默认=不含税额×退税率，可手工改）
  -- 单证齐全（外贸退税前置）
  doc_customs boolean NOT NULL DEFAULT false,    -- 报关单
  doc_invoice boolean NOT NULL DEFAULT false,    -- 增值税专票
  doc_forex boolean NOT NULL DEFAULT false,      -- 收汇
  -- 状态流转
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','declared','refunded')),  -- 待申报/已申报/已退税
  declared_at date,
  refund_received_amount numeric(15,2),     -- 实退金额（到账）
  refund_received_at date,                  -- 退税到账日期
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_refunds_status ON public.tax_refunds (status, export_date DESC);

ALTER TABLE public.tax_refunds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tax_refunds_read       ON public.tax_refunds;
DROP POLICY IF EXISTS tax_refunds_insert_fin ON public.tax_refunds;
DROP POLICY IF EXISTS tax_refunds_update_fin ON public.tax_refunds;
DROP POLICY IF EXISTS tax_refunds_delete_mgr ON public.tax_refunds;
CREATE POLICY tax_refunds_read ON public.tax_refunds
  FOR SELECT TO authenticated USING (true);
CREATE POLICY tax_refunds_insert_fin ON public.tax_refunds
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY tax_refunds_update_fin ON public.tax_refunds
  FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY tax_refunds_delete_mgr ON public.tax_refunds
  FOR DELETE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- 验证：
-- SELECT count(*) FROM public.tax_refunds;
