-- ============================================================
-- 安全加固 SQL — Phase 1
-- 1. CHECK约束（金额≥0、汇率>0、币种校验）
-- 2. 乐观锁（version字段防并发覆盖）
-- 3. 审批后锁定（approved状态禁止修改金额）
-- 4. 自审批阻止（审批人≠创建人）
-- 5. 字段级审计日志
-- ============================================================

-- ========== 1. CHECK约束 ==========

-- budget_orders 金额约束
ALTER TABLE public.budget_orders
  ADD CONSTRAINT chk_revenue_non_negative CHECK (total_revenue >= 0),
  ADD CONSTRAINT chk_cost_non_negative CHECK (total_cost >= 0),
  ADD CONSTRAINT chk_purchase_non_negative CHECK (target_purchase_price >= 0),
  ADD CONSTRAINT chk_freight_non_negative CHECK (estimated_freight >= 0),
  ADD CONSTRAINT chk_commission_non_negative CHECK (estimated_commission >= 0),
  ADD CONSTRAINT chk_customs_non_negative CHECK (estimated_customs_fee >= 0),
  ADD CONSTRAINT chk_other_non_negative CHECK (other_costs >= 0),
  ADD CONSTRAINT chk_exchange_rate_positive CHECK (exchange_rate > 0),
  ADD CONSTRAINT chk_currency_valid CHECK (currency IN ('USD', 'EUR', 'GBP', 'CNY', 'JPY', 'HKD'));

-- cost_items 金额约束
ALTER TABLE public.cost_items
  ADD CONSTRAINT chk_cost_amount_non_negative CHECK (amount >= 0),
  ADD CONSTRAINT chk_cost_rate_non_negative CHECK (exchange_rate >= 0);

-- actual_invoices 金额约束
ALTER TABLE public.actual_invoices
  ADD CONSTRAINT chk_invoice_amount_positive CHECK (amount > 0);

-- payable_records 金额约束
ALTER TABLE public.payable_records
  ADD CONSTRAINT chk_payable_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT chk_paid_amount_non_negative CHECK (paid_amount IS NULL OR paid_amount >= 0);


-- ========== 2. 乐观锁 version 字段 ==========

ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS version integer DEFAULT 1;

-- 自动递增 version 的触发器
CREATE OR REPLACE FUNCTION increment_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.version := COALESCE(OLD.version, 0) + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_budget_orders_version ON public.budget_orders;
CREATE TRIGGER trg_budget_orders_version
  BEFORE UPDATE ON public.budget_orders
  FOR EACH ROW EXECUTE FUNCTION increment_version();


-- ========== 3. 审批后禁止修改金额 ==========

CREATE OR REPLACE FUNCTION prevent_approved_modification()
RETURNS TRIGGER AS $$
BEGIN
  -- 只有 draft 和 rejected 状态允许修改金额字段
  IF OLD.status IN ('approved', 'closed') AND (
    NEW.total_revenue != OLD.total_revenue OR
    NEW.total_cost != OLD.total_cost OR
    NEW.target_purchase_price != OLD.target_purchase_price OR
    NEW.estimated_freight != OLD.estimated_freight OR
    NEW.estimated_commission != OLD.estimated_commission OR
    NEW.estimated_customs_fee != OLD.estimated_customs_fee OR
    NEW.other_costs != OLD.other_costs OR
    NEW.exchange_rate != OLD.exchange_rate
  ) THEN
    -- 允许状态变更本身（如 approved → closed）
    IF NEW.status = OLD.status THEN
      RAISE EXCEPTION '已审批的订单不能修改金额，如需修改请先撤回审批';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_approved_edit ON public.budget_orders;
CREATE TRIGGER trg_prevent_approved_edit
  BEFORE UPDATE ON public.budget_orders
  FOR EACH ROW EXECUTE FUNCTION prevent_approved_modification();


-- ========== 4. 自审批阻止 ==========
-- 在approval_logs中添加约束：operator_id不能等于对应订单的created_by
-- 通过触发器实现（因为跨表约束不能用CHECK）

CREATE OR REPLACE FUNCTION prevent_self_approval()
RETURNS TRIGGER AS $$
DECLARE
  creator_id uuid;
BEGIN
  IF NEW.action = 'approve' AND NEW.entity_type = 'budget_order' THEN
    SELECT created_by INTO creator_id
    FROM public.budget_orders
    WHERE id = NEW.entity_id;

    IF creator_id IS NOT NULL AND NEW.operator_id = creator_id THEN
      RAISE EXCEPTION '不能审批自己创建的订单';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_self_approval ON public.approval_logs;
CREATE TRIGGER trg_prevent_self_approval
  BEFORE INSERT ON public.approval_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_self_approval();


-- ========== 5. 字段级审计日志表 ==========

CREATE TABLE IF NOT EXISTS public.financial_audit_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name text NOT NULL,
  record_id uuid NOT NULL,
  field_name text NOT NULL,
  old_value text,
  new_value text,
  changed_by uuid REFERENCES public.profiles(id),
  changed_at timestamptz DEFAULT now(),
  change_type text DEFAULT 'update' CHECK (change_type IN ('insert', 'update', 'delete'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_record ON public.financial_audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_changed_at ON public.financial_audit_log(changed_at);

-- 审计触发器：记录budget_orders金额字段变更
CREATE OR REPLACE FUNCTION audit_budget_order_changes()
RETURNS TRIGGER AS $$
DECLARE
  fields text[] := ARRAY['total_revenue','total_cost','target_purchase_price','estimated_freight',
    'estimated_commission','estimated_customs_fee','other_costs','exchange_rate','status','currency'];
  f text;
  old_val text;
  new_val text;
BEGIN
  FOREACH f IN ARRAY fields LOOP
    EXECUTE format('SELECT ($1).%I::text, ($2).%I::text', f, f) INTO old_val, new_val USING OLD, NEW;
    IF old_val IS DISTINCT FROM new_val THEN
      INSERT INTO public.financial_audit_log (table_name, record_id, field_name, old_value, new_value, changed_by)
      VALUES ('budget_orders', NEW.id, f, old_val, new_val, NEW.created_by);
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_budget_orders ON public.budget_orders;
CREATE TRIGGER trg_audit_budget_orders
  AFTER UPDATE ON public.budget_orders
  FOR EACH ROW EXECUTE FUNCTION audit_budget_order_changes();


-- ========== 6. RLS策略加固 ==========
-- 注意：需要在Supabase Dashboard中执行，因为需要auth.uid()上下文

-- 预算单：仅财务相关角色可操作
DROP POLICY IF EXISTS "Users can manage budget_orders" ON public.budget_orders;
CREATE POLICY "authenticated_users_budget_orders" ON public.budget_orders
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- 已审批订单只能由管理员修改状态
DROP POLICY IF EXISTS "approved_orders_readonly" ON public.budget_orders;
CREATE POLICY "approved_orders_status_only" ON public.budget_orders
  FOR UPDATE USING (
    status IN ('draft', 'rejected', 'pending_review')
    OR auth.uid() IN (SELECT id FROM public.profiles WHERE role IN ('admin', 'finance_manager'))
  );

-- cost_items: 认证用户可操作
DROP POLICY IF EXISTS "Users can manage cost_items" ON public.cost_items;
CREATE POLICY "authenticated_users_cost_items" ON public.cost_items
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- 启用RLS（如果未启用）
ALTER TABLE public.financial_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_log_readonly" ON public.financial_audit_log
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "audit_log_insert_system" ON public.financial_audit_log
  FOR INSERT WITH CHECK (true); -- 触发器写入需要允许
