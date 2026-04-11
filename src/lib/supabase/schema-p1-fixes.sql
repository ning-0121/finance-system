-- ============================================================
-- P1 修复 — 状态机强制 + 凭证不可变 + 期间审计 + 付款防重复
-- ============================================================

-- ========== 1. 预算单状态机DB级强制 ==========
-- 只允许合法的状态转换，防止直接SQL绕过应用层校验

CREATE OR REPLACE FUNCTION enforce_budget_order_transitions()
RETURNS TRIGGER AS $$
BEGIN
  -- 状态未变不检查
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  -- 合法转换表
  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'pending_review') OR
    (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected', 'draft')) OR
    (OLD.status = 'approved' AND NEW.status = 'closed') OR
    (OLD.status = 'rejected' AND NEW.status = 'draft')
  ) THEN
    RAISE EXCEPTION '非法状态转换: % → %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_budget_order_transitions ON public.budget_orders;
CREATE TRIGGER trg_budget_order_transitions
  BEFORE UPDATE ON public.budget_orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_budget_order_transitions();


-- ========== 2. 应付记录状态机强制 ==========

CREATE OR REPLACE FUNCTION enforce_payable_transitions()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.payment_status = NEW.payment_status THEN RETURN NEW; END IF;

  IF NOT (
    (OLD.payment_status = 'unpaid' AND NEW.payment_status IN ('pending_approval', 'cancelled')) OR
    (OLD.payment_status = 'pending_approval' AND NEW.payment_status IN ('approved', 'unpaid', 'cancelled')) OR
    (OLD.payment_status = 'approved' AND NEW.payment_status IN ('paid', 'cancelled')) OR
    (OLD.payment_status = 'paid' AND FALSE) OR  -- paid是终态
    (OLD.payment_status = 'cancelled' AND FALSE) -- cancelled是终态
  ) THEN
    RAISE EXCEPTION '非法付款状态转换: % → %', OLD.payment_status, NEW.payment_status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payable_transitions ON public.payable_records;
CREATE TRIGGER trg_payable_transitions
  BEFORE UPDATE ON public.payable_records
  FOR EACH ROW
  WHEN (OLD.payment_status IS DISTINCT FROM NEW.payment_status)
  EXECUTE FUNCTION enforce_payable_transitions();


-- ========== 3. 已过账凭证不可变 ==========
-- posted凭证只能改status（void），不能改金额/科目

CREATE OR REPLACE FUNCTION enforce_journal_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'posted' THEN
    -- 只允许 posted → voided
    IF NEW.status != 'voided' AND NEW.status != OLD.status THEN
      RAISE EXCEPTION '已过账凭证只能作废，不能改为 %', NEW.status;
    END IF;
    -- 不允许改金额
    IF NEW.total_debit != OLD.total_debit OR NEW.total_credit != OLD.total_credit THEN
      RAISE EXCEPTION '已过账凭证不可修改金额';
    END IF;
    -- 不允许改描述
    IF NEW.description != OLD.description THEN
      RAISE EXCEPTION '已过账凭证不可修改摘要';
    END IF;
  END IF;

  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION '已作废凭证不可修改';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_immutability ON public.journal_entries;
CREATE TRIGGER trg_journal_immutability
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_journal_immutability();

-- 已过账凭证的明细行不可修改
CREATE OR REPLACE FUNCTION enforce_journal_lines_immutability()
RETURNS TRIGGER AS $$
DECLARE
  journal_status text;
BEGIN
  SELECT status INTO journal_status FROM public.journal_entries WHERE id = COALESCE(NEW.journal_id, OLD.journal_id);
  IF journal_status IN ('posted', 'voided') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '已过账/已作废凭证的明细行不可删除';
    ELSE
      RAISE EXCEPTION '已过账/已作废凭证的明细行不可修改';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_lines_immutability ON public.journal_lines;
CREATE TRIGGER trg_journal_lines_immutability
  BEFORE UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_journal_lines_immutability();


-- ========== 4. 会计期间重开审计 ==========
-- 期间从closed→open时必须记录谁、为什么

CREATE OR REPLACE FUNCTION audit_period_reopen()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status = 'open' THEN
    -- 记录审计日志
    INSERT INTO public.financial_audit_log (table_name, record_id, field_name, old_value, new_value, change_type)
    VALUES ('accounting_periods', NEW.id, 'status', 'closed', 'open', 'update');

    -- 保留原关闭信息到close_notes
    NEW.close_notes := COALESCE(NEW.close_notes, '') ||
      E'\n[重新开放] 原关闭时间: ' || COALESCE(OLD.closed_at::text, '未知') ||
      ', 重开时间: ' || now()::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_period_reopen_audit ON public.accounting_periods;
CREATE TRIGGER trg_period_reopen_audit
  BEFORE UPDATE ON public.accounting_periods
  FOR EACH ROW
  WHEN (OLD.status = 'closed' AND NEW.status = 'open')
  EXECUTE FUNCTION audit_period_reopen();


-- ========== 5. 付款防重复 ==========
-- 同一笔应付不能重复付款

CREATE OR REPLACE FUNCTION prevent_duplicate_payment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.payment_status = 'paid' AND OLD.payment_status = 'paid' THEN
    RAISE EXCEPTION '该笔应付已经付款，不能重复付款';
  END IF;
  -- paid时必须有paid_at
  IF NEW.payment_status = 'paid' AND NEW.paid_at IS NULL THEN
    NEW.paid_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_duplicate_payment ON public.payable_records;
CREATE TRIGGER trg_prevent_duplicate_payment
  BEFORE UPDATE ON public.payable_records
  FOR EACH ROW EXECUTE FUNCTION prevent_duplicate_payment();


-- ========== 6. 报表快照状态机 ==========

CREATE OR REPLACE FUNCTION enforce_snapshot_transitions()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'reviewing') OR
    (OLD.status = 'reviewing' AND NEW.status IN ('confirmed', 'draft')) OR
    (OLD.status = 'confirmed' AND NEW.status = 'locked') OR
    (OLD.status = 'locked' AND FALSE) -- locked是终态
  ) THEN
    RAISE EXCEPTION '非法报表状态转换: % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_snapshot_transitions ON public.report_snapshots;
CREATE TRIGGER trg_snapshot_transitions
  BEFORE UPDATE ON public.report_snapshots
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION enforce_snapshot_transitions();
