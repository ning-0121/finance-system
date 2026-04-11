-- ============================================================
-- 应付记录表 — 从决算中自动剥离产生
-- 在Supabase SQL Editor执行
-- ============================================================

CREATE TABLE IF NOT EXISTS public.payable_records (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  budget_order_id uuid REFERENCES public.budget_orders(id),
  settlement_id uuid REFERENCES public.order_settlements(id),
  invoice_id uuid REFERENCES public.actual_invoices(id),
  order_no text,                    -- 冗余存储方便查询
  supplier_name text NOT NULL,
  description text NOT NULL,
  cost_category text,               -- raw_material/factory/freight/commission/customs/tax/other
  amount numeric(15,2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  budget_amount numeric(15,2),       -- 预算金额（用于对比）
  over_budget boolean DEFAULT false,
  due_date date,
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','pending_approval','approved','paid','cancelled')),
  approved_by uuid REFERENCES public.profiles(id),
  approved_at timestamptz,
  paid_at timestamptz,
  paid_amount numeric(15,2),
  payment_method text,               -- bank_transfer/cash/check/other
  payment_reference text,            -- 付款凭证号/流水号
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.payable_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "v_payables" ON public.payable_records FOR SELECT USING (true);
CREATE POLICY "m_payables" ON public.payable_records FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_payables_order ON public.payable_records(budget_order_id);
CREATE INDEX IF NOT EXISTS idx_payables_supplier ON public.payable_records(supplier_name);
CREATE INDEX IF NOT EXISTS idx_payables_status ON public.payable_records(payment_status);
CREATE INDEX IF NOT EXISTS idx_payables_settlement ON public.payable_records(settlement_id);

CREATE TRIGGER update_payables_ts BEFORE UPDATE ON public.payable_records FOR EACH ROW EXECUTE PROCEDURE public.update_updated_at();
