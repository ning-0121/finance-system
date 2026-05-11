-- ============================================================
-- 状态机触发器 — 三张核心财务单据
-- actual_invoices / payable_records / shipping_documents
-- 防止非法状态回退和越级跳转
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. actual_invoices 状态机
--    合法路径: pending → approved → paid
--                      → disputed
--             pending → disputed
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_actual_invoice_status_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_old text := OLD.status;
  v_new text := NEW.status;
BEGIN
  IF v_old = v_new THEN RETURN NEW; END IF;

  IF NOT (
    (v_old = 'pending'  AND v_new IN ('approved', 'disputed')) OR
    (v_old = 'approved' AND v_new IN ('paid', 'disputed'))
  ) THEN
    RAISE EXCEPTION '非法状态转换: actual_invoices % → %', v_old, v_new;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_actual_invoice_status ON public.actual_invoices;
CREATE TRIGGER trg_actual_invoice_status
  BEFORE UPDATE OF status ON public.actual_invoices
  FOR EACH ROW EXECUTE FUNCTION trg_actual_invoice_status_fn();

-- ─────────────────────────────────────────────────────────────
-- 2. payable_records 状态机 (payment_status 字段)
--    合法路径: unpaid → pending_approval → approved → paid
--             unpaid → cancelled
--             pending_approval → cancelled
--             approved → cancelled  (需财务经理权限，业务层控制)
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_payable_status_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_old text := OLD.payment_status;
  v_new text := NEW.payment_status;
BEGIN
  IF v_old = v_new THEN RETURN NEW; END IF;

  IF NOT (
    (v_old = 'unpaid'           AND v_new IN ('pending_approval', 'cancelled')) OR
    (v_old = 'pending_approval' AND v_new IN ('approved', 'cancelled')) OR
    (v_old = 'approved'         AND v_new IN ('paid', 'cancelled')) OR
    (v_old = 'cancelled'        AND v_new = 'unpaid')  -- 允许取消后重置（财务撤销）
  ) THEN
    RAISE EXCEPTION '非法状态转换: payable_records.payment_status % → %', v_old, v_new;
  END IF;

  -- paid 是终态，禁止任何后续变更
  IF v_old = 'paid' THEN
    RAISE EXCEPTION '已过账: payable_records 已付款不可修改状态';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payable_status ON public.payable_records;
CREATE TRIGGER trg_payable_status
  BEFORE UPDATE OF payment_status ON public.payable_records
  FOR EACH ROW EXECUTE FUNCTION trg_payable_status_fn();

-- ─────────────────────────────────────────────────────────────
-- 3. shipping_documents 状态机
--    合法路径: draft → submitted → completed
--             draft → completed  (允许直接完成，如人工录入)
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_shipping_doc_status_fn()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_old text := OLD.status;
  v_new text := NEW.status;
BEGIN
  IF v_old = v_new THEN RETURN NEW; END IF;

  IF NOT (
    (v_old = 'draft'     AND v_new IN ('submitted', 'completed')) OR
    (v_old = 'submitted' AND v_new = 'completed')
  ) THEN
    RAISE EXCEPTION '非法状态转换: shipping_documents % → %', v_old, v_new;
  END IF;

  -- completed 是终态
  IF v_old = 'completed' THEN
    RAISE EXCEPTION '已关闭: shipping_documents 已完成不可回退';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shipping_doc_status ON public.shipping_documents;
CREATE TRIGGER trg_shipping_doc_status
  BEFORE UPDATE OF status ON public.shipping_documents
  FOR EACH ROW EXECUTE FUNCTION trg_shipping_doc_status_fn();
