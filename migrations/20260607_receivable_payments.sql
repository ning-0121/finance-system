-- ============================================================
-- 回款流水层（财务级修正版）：流水明细 → 匹配关系 → projection 汇总
--
-- 设计要点（对应评审 1–10）：
--  1) allocations 不级联删除（RESTRICT）；作废用 void（voided_at），不物理删
--  2) allocations.budget_order_id FK → budget_orders(id)
--  3) receipts.budget_order_id 仅 quick link（FK，SET NULL），权威匹配在 allocations
--  4) RLS 限定 TO authenticated（后续按角色再收紧）
--  5) CHECK：amount_original/exchange_rate/amount_cny>0；allocation amount_cny>0、amount_original>=0
--  6) 防超分配：BEFORE 触发器，同一 receipt 有效 allocation 合计不得超过 receipt.amount_cny
--  7) matched_status 由 allocations 合计自动推导（触发器）；disputed 仅人工+原因
--  8) 审计字段：updated_at/by、voided_at/by、void_reason
--  9) 事务型 RPC：allocate / unallocate / void，内部校验+更新状态+更新 projection+写诊断日志
-- 10) 幂等：payment_reference 非空时 (customer_name,bank_account,received_at,amount_cny,payment_reference) 唯一
--
-- 可加可逆。回滚见 20260607_receivable_payments.down.sql
-- ============================================================

-- ── 表 1：回款流水 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.receivable_payments (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id        uuid,
  customer_name      text,
  budget_order_id    uuid REFERENCES public.budget_orders(id) ON DELETE SET NULL,  -- quick link，非权威
  amount_original    numeric(15,2) NOT NULL CHECK (amount_original > 0),
  currency           text NOT NULL DEFAULT 'CNY',
  exchange_rate      numeric(12,4) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  amount_cny         numeric(15,2) NOT NULL CHECK (amount_cny > 0),
  received_at        date,
  bank_account       text,
  payment_reference  text,
  source_type        text NOT NULL DEFAULT 'manual'
                       CHECK (source_type IN ('manual','bank_receipt','wecom_file','ocr')),
  source_document_id uuid,
  matched_status     text NOT NULL DEFAULT 'unmatched'
                       CHECK (matched_status IN ('unmatched','partially_matched','matched','disputed')),
  dispute_reason     text,
  notes              text,
  created_by         uuid REFERENCES public.profiles(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES public.profiles(id),
  voided_at          timestamptz,
  voided_by          uuid REFERENCES public.profiles(id),
  void_reason        text
);

-- ── 表 2：匹配分配（权威）─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.receivable_payment_allocations (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  receipt_id      uuid NOT NULL REFERENCES public.receivable_payments(id) ON DELETE RESTRICT,
  budget_order_id uuid NOT NULL REFERENCES public.budget_orders(id) ON DELETE RESTRICT,
  amount_cny      numeric(15,2) NOT NULL CHECK (amount_cny > 0),
  amount_original numeric(15,2) CHECK (amount_original IS NULL OR amount_original >= 0),
  created_by      uuid REFERENCES public.profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES public.profiles(id),
  void_reason     text
);

CREATE INDEX IF NOT EXISTS idx_recv_pay_customer  ON public.receivable_payments (customer_name) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recv_pay_status    ON public.receivable_payments (matched_status) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recv_alloc_order   ON public.receivable_payment_allocations (budget_order_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recv_alloc_receipt ON public.receivable_payment_allocations (receipt_id) WHERE voided_at IS NULL;

-- 幂等：有银行流水号时，不允许同口径重复录入
CREATE UNIQUE INDEX IF NOT EXISTS uq_recv_pay_dedup
  ON public.receivable_payments (customer_name, bank_account, received_at, amount_cny, payment_reference)
  WHERE payment_reference IS NOT NULL AND voided_at IS NULL;

-- ── RLS：仅 authenticated（开发期；后续按角色收紧）──────────
ALTER TABLE public.receivable_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_payment_allocations ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['receivable_payments','receivable_payment_allocations'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_sel" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_ins" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_upd" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_del" ON public.%1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_sel" ON public.%1$s FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('CREATE POLICY "%1$s_ins" ON public.%1$s FOR INSERT TO authenticated WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY "%1$s_upd" ON public.%1$s FOR UPDATE TO authenticated USING (true)', t);
    EXECUTE format('CREATE POLICY "%1$s_del" ON public.%1$s FOR DELETE TO authenticated USING (true)', t);
  END LOOP;
END $$;

-- ── 内部：重算某订单 ar_received_amount projection ─────────
CREATE OR REPLACE FUNCTION public._refresh_order_ar_projection(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_cny numeric; v_last date; v_rate numeric;
BEGIN
  SELECT COALESCE(SUM(a.amount_cny),0), MAX(p.received_at)
    INTO v_cny, v_last
  FROM public.receivable_payment_allocations a
  JOIN public.receivable_payments p ON p.id = a.receipt_id
  WHERE a.budget_order_id = p_order_id AND a.voided_at IS NULL AND p.voided_at IS NULL;

  SELECT COALESCE(NULLIF(exchange_rate,0),1) INTO v_rate FROM public.budget_orders WHERE id = p_order_id;
  IF v_rate IS NULL THEN RETURN; END IF;  -- 订单不存在

  UPDATE public.budget_orders
     SET ar_received_amount = round(v_cny / v_rate, 2),
         ar_received_at = v_last,
         updated_at = now()
   WHERE id = p_order_id;
END $$;

-- ── 内部：按 allocations 合计重算 receipt.matched_status ───
CREATE OR REPLACE FUNCTION public._recalc_receipt_match(p_receipt_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_amount numeric; v_status text; v_voided timestamptz; v_alloc numeric;
BEGIN
  SELECT amount_cny, matched_status, voided_at INTO v_amount, v_status, v_voided
    FROM public.receivable_payments WHERE id = p_receipt_id FOR UPDATE;
  IF v_amount IS NULL OR v_voided IS NOT NULL THEN RETURN; END IF;
  IF v_status = 'disputed' THEN RETURN; END IF;  -- 争议态仅人工
  SELECT COALESCE(SUM(amount_cny),0) INTO v_alloc
    FROM public.receivable_payment_allocations WHERE receipt_id = p_receipt_id AND voided_at IS NULL;
  UPDATE public.receivable_payments
     SET matched_status = CASE
           WHEN v_alloc <= 0.005 THEN 'unmatched'
           WHEN v_alloc + 0.005 < v_amount THEN 'partially_matched'
           ELSE 'matched' END,
         updated_at = now()
   WHERE id = p_receipt_id;
END $$;

-- ── 触发器：防超分配（DB 级硬约束，不依赖前端）────────────
CREATE OR REPLACE FUNCTION public._trg_alloc_no_over()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_amount numeric; v_sum numeric;
BEGIN
  IF NEW.voided_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT amount_cny INTO v_amount FROM public.receivable_payments
    WHERE id = NEW.receipt_id AND voided_at IS NULL;
  IF v_amount IS NULL THEN RAISE EXCEPTION 'RECEIPT_VOIDED_OR_MISSING: 回款不存在或已作废'; END IF;
  SELECT COALESCE(SUM(amount_cny),0) INTO v_sum
    FROM public.receivable_payment_allocations
    WHERE receipt_id = NEW.receipt_id AND voided_at IS NULL AND id <> NEW.id;
  IF v_sum + NEW.amount_cny > v_amount + 0.005 THEN
    RAISE EXCEPTION 'OVER_ALLOCATION: 分配合计 % 超过回款金额 %', v_sum + NEW.amount_cny, v_amount;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_alloc_no_over ON public.receivable_payment_allocations;
CREATE TRIGGER trg_alloc_no_over BEFORE INSERT OR UPDATE ON public.receivable_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public._trg_alloc_no_over();

-- ── 触发器：分配变动后自动重算 matched_status ─────────────
CREATE OR REPLACE FUNCTION public._trg_alloc_recalc()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public._recalc_receipt_match(COALESCE(NEW.receipt_id, OLD.receipt_id));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_alloc_recalc ON public.receivable_payment_allocations;
CREATE TRIGGER trg_alloc_recalc AFTER INSERT OR UPDATE OR DELETE ON public.receivable_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public._trg_alloc_recalc();

-- ── RPC：匹配（分配一笔回款到某订单）──────────────────────
CREATE OR REPLACE FUNCTION public.allocate_receivable_payment(
  p_receipt_id uuid, p_budget_order_id uuid, p_amount_cny numeric,
  p_amount_original numeric DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_alloc_id uuid; v_voided timestamptz;
BEGIN
  IF p_amount_cny IS NULL OR p_amount_cny <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT: 分配金额必须>0'; END IF;
  SELECT voided_at INTO v_voided FROM public.receivable_payments WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECEIPT_NOT_FOUND'; END IF;
  IF v_voided IS NOT NULL THEN RAISE EXCEPTION 'RECEIPT_VOIDED: 回款已作废，不可匹配'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.budget_orders WHERE id = p_budget_order_id) THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: 订单不存在'; END IF;

  INSERT INTO public.receivable_payment_allocations (receipt_id, budget_order_id, amount_cny, amount_original, created_by)
  VALUES (p_receipt_id, p_budget_order_id, round(p_amount_cny,2), p_amount_original, p_actor)
  RETURNING id INTO v_alloc_id;   -- 防超分配由 BEFORE 触发器把关；matched_status 由 AFTER 触发器重算

  PERFORM public._refresh_order_ar_projection(p_budget_order_id);

  BEGIN
    INSERT INTO public.entity_timeline (entity_type, entity_id, event_type, event_title, event_detail, source_type, actor_id)
    VALUES ('receivable_payment', p_receipt_id, 'allocate', '回款匹配到订单',
            jsonb_build_object('allocation_id', v_alloc_id, 'budget_order_id', p_budget_order_id, 'amount_cny', round(p_amount_cny,2)),
            'system', p_actor);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('allocation_id', v_alloc_id);
END $$;
GRANT EXECUTE ON FUNCTION public.allocate_receivable_payment(uuid, uuid, numeric, numeric, uuid) TO authenticated;

-- ── RPC：撤销匹配（void 一条分配）────────────────────────
CREATE OR REPLACE FUNCTION public.unallocate_receivable_payment(
  p_allocation_id uuid, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_order uuid; v_receipt uuid; v_voided timestamptz;
BEGIN
  SELECT budget_order_id, receipt_id, voided_at INTO v_order, v_receipt, v_voided
    FROM public.receivable_payment_allocations WHERE id = p_allocation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ALLOCATION_NOT_FOUND'; END IF;
  IF v_voided IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_VOIDED'; END IF;

  UPDATE public.receivable_payment_allocations
     SET voided_at = now(), voided_by = p_actor, void_reason = p_reason
   WHERE id = p_allocation_id;   -- AFTER 触发器重算 matched_status

  PERFORM public._refresh_order_ar_projection(v_order);

  BEGIN
    INSERT INTO public.entity_timeline (entity_type, entity_id, event_type, event_title, event_detail, source_type, actor_id)
    VALUES ('receivable_payment', v_receipt, 'unallocate', '撤销回款匹配',
            jsonb_build_object('allocation_id', p_allocation_id, 'budget_order_id', v_order, 'reason', p_reason),
            'system', p_actor);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('allocation_id', p_allocation_id, 'voided', true);
END $$;
GRANT EXECUTE ON FUNCTION public.unallocate_receivable_payment(uuid, uuid, text) TO authenticated;

-- ── RPC：作废整笔回款（连同其有效分配一起 void）──────────
CREATE OR REPLACE FUNCTION public.void_receivable_payment(
  p_receipt_id uuid, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.receivable_payments WHERE id = p_receipt_id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND_OR_VOIDED'; END IF;
  FOR r IN SELECT id, budget_order_id FROM public.receivable_payment_allocations
           WHERE receipt_id = p_receipt_id AND voided_at IS NULL LOOP
    UPDATE public.receivable_payment_allocations
       SET voided_at = now(), voided_by = p_actor, void_reason = COALESCE(p_reason,'receipt voided')
     WHERE id = r.id;
    PERFORM public._refresh_order_ar_projection(r.budget_order_id);
  END LOOP;
  UPDATE public.receivable_payments
     SET voided_at = now(), voided_by = p_actor, void_reason = p_reason, matched_status = 'unmatched', updated_at = now()
   WHERE id = p_receipt_id;
  RETURN jsonb_build_object('receipt_id', p_receipt_id, 'voided', true);
END $$;
GRANT EXECUTE ON FUNCTION public.void_receivable_payment(uuid, uuid, text) TO authenticated;

-- 验证：
-- SELECT to_regclass('public.receivable_payments'), to_regclass('public.receivable_payment_allocations');
-- SELECT proname FROM pg_proc WHERE proname IN ('allocate_receivable_payment','unallocate_receivable_payment','void_receivable_payment');
