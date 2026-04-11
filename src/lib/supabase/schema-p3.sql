-- ============================================================
-- P3: 库存管理 + 预付预收 + 定时对账
-- ============================================================

-- ========== 1. 库存管理 ==========

CREATE TABLE IF NOT EXISTS public.inventory (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  material_code text NOT NULL,               -- 物料编码
  material_name text NOT NULL,               -- 物料名称
  category text NOT NULL CHECK (category IN ('fabric', 'accessory', 'finished', 'sample', 'other')),
  unit text NOT NULL DEFAULT '米',            -- 单位（米/kg/件/卷）
  current_qty numeric(15,3) NOT NULL DEFAULT 0,
  unit_cost numeric(15,4) DEFAULT 0,         -- 单位成本（加权平均）
  total_value numeric(15,2) DEFAULT 0,       -- 库存金额 = qty × unit_cost
  warehouse text DEFAULT '主仓',
  min_stock numeric(15,3) DEFAULT 0,         -- 安全库存
  supplier_name text,
  last_in_date date,
  last_out_date date,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT chk_qty_non_negative CHECK (current_qty >= 0)
);

CREATE TABLE IF NOT EXISTS public.inventory_transactions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  inventory_id uuid NOT NULL REFERENCES public.inventory(id),
  transaction_type text NOT NULL CHECK (transaction_type IN ('in', 'out', 'adjust', 'return')),
  qty numeric(15,3) NOT NULL,                -- 正=入库 负=出库
  unit_cost numeric(15,4),
  total_amount numeric(15,2),
  order_id uuid REFERENCES public.budget_orders(id),
  reference_no text,                          -- 关联单据号
  reason text,
  operated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz DEFAULT now()
);

-- 库存变动时自动更新库存表
CREATE OR REPLACE FUNCTION update_inventory_on_transaction()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.inventory SET
    current_qty = current_qty + NEW.qty,
    total_value = (current_qty + NEW.qty) * unit_cost,
    last_in_date = CASE WHEN NEW.qty > 0 THEN CURRENT_DATE ELSE last_in_date END,
    last_out_date = CASE WHEN NEW.qty < 0 THEN CURRENT_DATE ELSE last_out_date END,
    updated_at = now()
  WHERE id = NEW.inventory_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_transaction ON public.inventory_transactions;
CREATE TRIGGER trg_inventory_transaction
  AFTER INSERT ON public.inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION update_inventory_on_transaction();

CREATE INDEX IF NOT EXISTS idx_inventory_category ON public.inventory(category);
CREATE INDEX IF NOT EXISTS idx_inventory_txn_inventory ON public.inventory_transactions(inventory_id);
CREATE INDEX IF NOT EXISTS idx_inventory_txn_order ON public.inventory_transactions(order_id);


-- ========== 2. 预付/预收 ==========

CREATE TABLE IF NOT EXISTS public.prepayments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_type text NOT NULL CHECK (payment_type IN (
    'customer_deposit',   -- 客户预收定金
    'supplier_advance',   -- 供应商预付款
    'customer_refund',    -- 客户退款
    'supplier_refund'     -- 供应商退款
  )),
  counterparty_name text NOT NULL,            -- 对方名称
  counterparty_type text NOT NULL CHECK (counterparty_type IN ('customer', 'supplier')),
  customer_id uuid REFERENCES public.customers(id),
  order_id uuid REFERENCES public.budget_orders(id),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'CNY',
  exchange_rate numeric(10,4) DEFAULT 1,
  payment_date date NOT NULL,
  payment_method text DEFAULT 'bank_transfer',
  payment_reference text,                     -- 付款凭证号
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'applied', 'refunded')),
  applied_amount numeric(15,2) DEFAULT 0,     -- 已核销金额
  remaining_amount numeric(15,2),             -- 剩余金额 = amount - applied
  applied_to_invoices jsonb DEFAULT '[]',     -- 核销明细
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 自动计算剩余金额
CREATE OR REPLACE FUNCTION update_prepayment_remaining()
RETURNS TRIGGER AS $$
BEGIN
  NEW.remaining_amount := NEW.amount - COALESCE(NEW.applied_amount, 0);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prepayment_remaining ON public.prepayments;
CREATE TRIGGER trg_prepayment_remaining
  BEFORE INSERT OR UPDATE ON public.prepayments
  FOR EACH ROW EXECUTE FUNCTION update_prepayment_remaining();

CREATE INDEX IF NOT EXISTS idx_prepayments_order ON public.prepayments(order_id);
CREATE INDEX IF NOT EXISTS idx_prepayments_customer ON public.prepayments(customer_id);
CREATE INDEX IF NOT EXISTS idx_prepayments_type ON public.prepayments(payment_type);


-- ========== 3. 定时对账检查表 ==========

CREATE TABLE IF NOT EXISTS public.reconciliation_checks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  check_type text NOT NULL CHECK (check_type IN (
    'gl_balance',         -- 总账借贷平衡
    'ar_consistency',     -- 应收账款一致性
    'ap_consistency',     -- 应付账款一致性
    'bank_reconciliation',-- 银行对账
    'inventory_value',    -- 库存金额一致性
    'period_close_ready', -- 期间关闭就绪
    'fx_revaluation'      -- 外汇重估
  )),
  period_code text,
  check_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'warning')),
  expected_value numeric(15,2),
  actual_value numeric(15,2),
  variance numeric(15,2),
  details jsonb,
  checked_by uuid REFERENCES public.profiles(id),
  resolved_by uuid REFERENCES public.profiles(id),
  resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_type ON public.reconciliation_checks(check_type);
CREATE INDEX IF NOT EXISTS idx_reconciliation_period ON public.reconciliation_checks(period_code);
CREATE INDEX IF NOT EXISTS idx_reconciliation_status ON public.reconciliation_checks(status);


-- ========== 4. RLS ==========

ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prepayments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inventory_all" ON public.inventory FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "inventory_txn_all" ON public.inventory_transactions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "prepayments_all" ON public.prepayments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "reconciliation_all" ON public.reconciliation_checks FOR ALL USING (true) WITH CHECK (true);
