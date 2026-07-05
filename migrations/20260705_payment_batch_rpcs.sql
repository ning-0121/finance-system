-- ============================================================
-- 周排款子系统 · ②引擎层(原子 RPC)
--
-- 所有防重复付款的判断都在这层,用 FOR UPDATE 行锁 + 单事务保证,应用层绕不过：
--   create_payment_batch      建周排款单(单一币种,生成单号)
--   add_payment_batch_line    加一笔应付进单 —— 行锁校验 Σ已排+已付 ≤ 应付额(不能重复排/超排)
--   remove_payment_batch_line 移出一行(仅 draft + planned)
--   submit_payment_batch      财务提交(draft→submitted,须≥1行)
--   approve_payment_batch     老板审批放款(submitted→approved)
--   execute_batch_line_payment 出纳执行 —— 唯一出款口:行锁校验不超付 → 原子写实付
--                              +涨 paid_amount +推应付状态 +幂等(executed_at/唯一键)
--   close_payment_batch       关单(收尾)
--   cancel_payment_batch      作废(无已付行时)
--
-- 幂等/防重三重锁：① Σ≤应付额(add 时行锁) ② new_paid≤应付额(execute 时行锁)
--   ③ supplier_payments.source_batch_line_id 唯一 + (supplier,payment_ref) 唯一(DB 兜底)
--
-- 依赖 20260705_payment_batch_schema.sql。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- create_payment_batch · 建周排款单
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_payment_batch(
  p_actor            uuid,
  p_currency         text,
  p_planned_pay_date date DEFAULT NULL,
  p_title            text DEFAULT NULL,
  p_week_label       text DEFAULT NULL,
  p_notes            text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_date  date := coalesce(p_planned_pay_date, current_date);
  v_week  text := coalesce(p_week_label, to_char(v_date,'IYYY') || '-W' || to_char(v_date,'IW'));
  v_ccy   text := upper(coalesce(nullif(trim(p_currency),''),'CNY'));
  v_seq   int;
  v_no    text;
  v_id    uuid;
BEGIN
  SELECT coalesce(max(substring(batch_no from '[0-9]+$')::int),0)+1 INTO v_seq
  FROM public.payment_batches
  WHERE batch_no LIKE 'PR-'||to_char(v_date,'YYYYMMDD')||'-'||v_ccy||'-%';
  v_no := 'PR-'||to_char(v_date,'YYYYMMDD')||'-'||v_ccy||'-'||lpad(v_seq::text,2,'0');

  INSERT INTO public.payment_batches (batch_no, title, currency, week_label, planned_pay_date, status, created_by, notes)
  VALUES (v_no, p_title, v_ccy, v_week, p_planned_pay_date, 'draft', p_actor, p_notes)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'batch_no', v_no, 'currency', v_ccy, 'status', 'draft', 'week_label', v_week);
END $$;

-- ─────────────────────────────────────────────────────────────
-- add_payment_batch_line · 加一笔应付进排款单(核心防重复排闸)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_payment_batch_line(
  p_batch_id   uuid,
  p_payable_id uuid,
  p_pay_amount numeric,   -- 本行计划付款额;NULL/<=0 视为「付剩余全部」
  p_actor      uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch     record;
  v_payable   record;
  v_reserved  numeric;   -- 该应付已排(未关闭行)累计
  v_remaining numeric;   -- 剩余可排 = amount - paid_amount - reserved
  v_pay       numeric;
  v_line_id   uuid;
BEGIN
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND: 排款单不存在'; END IF;
  IF v_batch.status <> 'draft' THEN
    RAISE EXCEPTION 'BATCH_NOT_DRAFT: 排款单已提交/审批(status=%),不能再加行', v_batch.status;
  END IF;

  SELECT * INTO v_payable FROM public.payable_records WHERE id = p_payable_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYABLE_NOT_FOUND: 应付不存在'; END IF;
  IF v_payable.payment_status IN ('paid','cancelled') THEN
    RAISE EXCEPTION 'PAYABLE_CLOSED: 应付已 %,不可排款', v_payable.payment_status;
  END IF;
  IF upper(v_payable.currency) <> v_batch.currency THEN
    RAISE EXCEPTION 'CURRENCY_MISMATCH: 应付币种 % 与排款单 % 不一致(单一币种)', v_payable.currency, v_batch.currency;
  END IF;

  -- 已排(所有未关闭行,含其他排款单里的 planned/held/paid)—— 防重复排的关键
  SELECT coalesce(sum(pay_amount),0) INTO v_reserved
  FROM public.payment_batch_lines
  WHERE payable_id = p_payable_id AND deleted_at IS NULL AND status IN ('planned','held','paid');

  v_remaining := v_payable.amount - coalesce(v_payable.paid_amount,0) - v_reserved;
  IF v_remaining <= 0.005 THEN
    RAISE EXCEPTION 'NOTHING_TO_SCHEDULE: 该应付已全额排款/付清(应付%,已付%,已排%),无剩余可排',
      v_payable.amount, coalesce(v_payable.paid_amount,0), v_reserved;
  END IF;

  v_pay := coalesce(nullif(p_pay_amount,0), v_remaining);
  IF v_pay <= 0 THEN v_pay := v_remaining; END IF;
  IF v_pay > v_remaining + 0.005 THEN
    RAISE EXCEPTION 'EXCEEDS_REMAINING: 本次排款 % 超过剩余可排 %(应付%-已付%-已排%)',
      v_pay, v_remaining, v_payable.amount, coalesce(v_payable.paid_amount,0), v_reserved;
  END IF;

  INSERT INTO public.payment_batch_lines (
    batch_id, payable_id, supplier_name, pay_amount, currency,
    payee_name, payee_account, payee_bank, status
  ) VALUES (
    p_batch_id, p_payable_id, v_payable.supplier_name, v_pay, v_batch.currency,
    v_payable.payee_name, v_payable.payee_account, v_payable.payee_bank, 'planned'
  ) RETURNING id INTO v_line_id;

  UPDATE public.payment_batches
  SET total_amount = total_amount + v_pay
  WHERE id = p_batch_id;

  RETURN jsonb_build_object('line_id', v_line_id, 'pay_amount', v_pay,
    'remaining_before', v_remaining, 'payable_id', p_payable_id);
END $$;

-- ─────────────────────────────────────────────────────────────
-- remove_payment_batch_line · 移出一行(仅 draft 单 + planned/held 行)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.remove_payment_batch_line(
  p_line_id uuid,
  p_actor   uuid,
  p_reason  text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_line record; v_batch record;
BEGIN
  SELECT * INTO v_line FROM public.payment_batch_lines WHERE id = p_line_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINE_NOT_FOUND: 排款行不存在'; END IF;
  IF v_line.status = 'paid' THEN RAISE EXCEPTION 'LINE_PAID: 已付款的行不可移出'; END IF;

  SELECT * INTO v_batch FROM public.payment_batches WHERE id = v_line.batch_id FOR UPDATE;
  IF v_batch.status <> 'draft' THEN
    RAISE EXCEPTION 'BATCH_NOT_DRAFT: 排款单已提交(status=%),行已锁定', v_batch.status;
  END IF;

  UPDATE public.payment_batch_lines
  SET deleted_at = now(), deleted_by = p_actor, delete_reason = p_reason, status = 'skipped'
  WHERE id = p_line_id;

  UPDATE public.payment_batches SET total_amount = greatest(total_amount - v_line.pay_amount, 0)
  WHERE id = v_line.batch_id;

  RETURN jsonb_build_object('line_id', p_line_id, 'removed', true);
END $$;

-- ─────────────────────────────────────────────────────────────
-- submit_payment_batch · 财务提交(draft→submitted)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_payment_batch(p_batch_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_batch record; v_n int;
BEGIN
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
  IF v_batch.status <> 'draft' THEN RAISE EXCEPTION 'BATCH_NOT_DRAFT: 当前 %,只有草稿可提交', v_batch.status; END IF;
  SELECT count(*) INTO v_n FROM public.payment_batch_lines WHERE batch_id = p_batch_id AND deleted_at IS NULL AND status IN ('planned','held');
  IF v_n < 1 THEN RAISE EXCEPTION 'EMPTY_BATCH: 排款单没有明细,不能提交'; END IF;

  UPDATE public.payment_batches SET status='submitted', submitted_by=p_actor, submitted_at=now() WHERE id=p_batch_id;
  RETURN jsonb_build_object('id', p_batch_id, 'status', 'submitted', 'lines', v_n);
END $$;

-- ─────────────────────────────────────────────────────────────
-- approve_payment_batch · 老板审批放款(submitted→approved)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_payment_batch(p_batch_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_batch record;
BEGIN
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
  IF v_batch.status <> 'submitted' THEN RAISE EXCEPTION 'BATCH_NOT_SUBMITTED: 当前 %,只有已提交可审批', v_batch.status; END IF;

  UPDATE public.payment_batches SET status='approved', approved_by=p_actor, approved_at=now() WHERE id=p_batch_id;
  RETURN jsonb_build_object('id', p_batch_id, 'status', 'approved');
END $$;

-- ─────────────────────────────────────────────────────────────
-- execute_batch_line_payment · 出纳执行(唯一出款口,原子防重复付款)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.execute_batch_line_payment(
  p_line_id     uuid,
  p_actor       uuid,
  p_payment_ref text,               -- 付款凭证号(银行流水/回单/发票号)—— 强建议填
  p_paid_at     date DEFAULT NULL,
  p_note        text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_line     record;
  v_batch    record;
  v_payable  record;
  v_new_paid numeric;
  v_status   text;
  v_pay_id   uuid;
  v_left     int;
BEGIN
  -- 1. 锁行,幂等：非 planned 直接拒(已付/已移出)
  SELECT * INTO v_line FROM public.payment_batch_lines WHERE id = p_line_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINE_NOT_FOUND: 排款行不存在'; END IF;
  IF v_line.status = 'paid' THEN RAISE EXCEPTION 'ALREADY_PAID: 该行已付款(executed_at=%),不可重复执行', v_line.executed_at; END IF;
  IF v_line.status <> 'planned' THEN RAISE EXCEPTION 'LINE_NOT_PAYABLE: 行状态 %,不可执行', v_line.status; END IF;

  -- 2. 锁单,须已审批放款
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = v_line.batch_id FOR UPDATE;
  IF v_batch.status NOT IN ('approved','executing') THEN
    RAISE EXCEPTION 'BATCH_NOT_APPROVED: 排款单 status=%,未审批放款不能付款', v_batch.status;
  END IF;

  -- 3. 锁应付,不超付
  SELECT * INTO v_payable FROM public.payable_records WHERE id = v_line.payable_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYABLE_NOT_FOUND'; END IF;
  v_new_paid := coalesce(v_payable.paid_amount,0) + v_line.pay_amount;
  IF v_new_paid > v_payable.amount + 0.005 THEN
    RAISE EXCEPTION 'OVERPAY: 累计已付 % 将超应付额 %(本次%)', v_new_paid, v_payable.amount, v_line.pay_amount;
  END IF;

  -- 4. 写实付流水(唯一出款动作)。source_batch_line_id 唯一 + (supplier,payment_ref) 唯一 兜底防重
  BEGIN
    INSERT INTO public.supplier_payments (
      supplier_name, amount, currency, paid_at, note, payment_ref,
      source_batch_line_id, created_by
    ) VALUES (
      v_line.supplier_name, v_line.pay_amount, v_line.currency,
      coalesce(p_paid_at, current_date),
      coalesce(p_note, '排款单 '||v_batch.batch_no||' 执行付款'),
      nullif(trim(p_payment_ref),''),
      p_line_id, p_actor
    ) RETURNING id INTO v_pay_id;
  EXCEPTION
    WHEN unique_violation THEN
      IF SQLERRM ILIKE '%batch_line%' THEN
        RAISE EXCEPTION 'ALREADY_PAID: 该排款行已生成过实付,不可重复付款';
      ELSIF SQLERRM ILIKE '%supplier_ref%' THEN
        RAISE EXCEPTION 'DUP_REF: 凭证号「%」在供应商 % 下已登记过付款,不可重复付款', p_payment_ref, v_line.supplier_name;
      ELSE RAISE;
      END IF;
  END;

  -- 5. 推进应付：部分付 → partially_paid;付清 → paid
  v_status := CASE WHEN v_new_paid >= v_payable.amount - 0.005 THEN 'paid' ELSE 'partially_paid' END;
  UPDATE public.payable_records
  SET paid_amount = v_new_paid,
      payment_status = v_status,
      paid_at = coalesce(paid_at, now()),
      payment_reference = coalesce(nullif(trim(p_payment_ref),''), payment_reference),
      payment_method = coalesce(payment_method, 'bank_transfer')
  WHERE id = v_payable.id;

  -- 6. 行落地
  UPDATE public.payment_batch_lines
  SET status='paid', payment_id=v_pay_id, payment_ref=nullif(trim(p_payment_ref),''),
      executed_at=now(), executed_by=p_actor
  WHERE id = p_line_id;

  -- 7. 排款单累计 + 状态推进(首次执行 approved→executing;无待付行→closed)
  SELECT count(*) INTO v_left FROM public.payment_batch_lines
  WHERE batch_id = v_batch.id AND deleted_at IS NULL AND status IN ('planned','held');
  UPDATE public.payment_batches
  SET paid_total = paid_total + v_line.pay_amount,
      status = CASE WHEN v_left = 0 THEN 'closed' ELSE 'executing' END,
      closed_at = CASE WHEN v_left = 0 THEN now() ELSE closed_at END
  WHERE id = v_batch.id;

  RETURN jsonb_build_object(
    'payment_id', v_pay_id, 'line_id', p_line_id, 'payable_id', v_payable.id,
    'paid_amount', v_new_paid, 'payable_status', v_status,
    'batch_status', CASE WHEN v_left = 0 THEN 'closed' ELSE 'executing' END
  );
END $$;

-- ─────────────────────────────────────────────────────────────
-- close_payment_batch · 收尾关单(把未付的 planned 行留着也可强制关)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.close_payment_batch(p_batch_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_batch record;
BEGIN
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
  IF v_batch.status NOT IN ('approved','executing') THEN
    RAISE EXCEPTION 'BATCH_NOT_CLOSABLE: 当前 %,只有已审批/执行中可关单', v_batch.status;
  END IF;
  -- 未付的 planned 行标记 skipped(本单不付了,应付剩余下周可再排)
  UPDATE public.payment_batch_lines SET status='skipped'
  WHERE batch_id=p_batch_id AND deleted_at IS NULL AND status IN ('planned','held');
  UPDATE public.payment_batches SET status='closed', closed_at=now() WHERE id=p_batch_id;
  RETURN jsonb_build_object('id', p_batch_id, 'status', 'closed');
END $$;

-- ─────────────────────────────────────────────────────────────
-- cancel_payment_batch · 作废(仅无已付行时)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_payment_batch(p_batch_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_batch record; v_paid int;
BEGIN
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
  IF v_batch.status = 'closed' THEN RAISE EXCEPTION 'BATCH_CLOSED: 已关单不可作废'; END IF;
  SELECT count(*) INTO v_paid FROM public.payment_batch_lines WHERE batch_id=p_batch_id AND deleted_at IS NULL AND status='paid';
  IF v_paid > 0 THEN RAISE EXCEPTION 'HAS_PAID_LINES: 已有 % 行完成付款,不能作废(请改用关单)', v_paid; END IF;

  UPDATE public.payment_batch_lines SET status='skipped' WHERE batch_id=p_batch_id AND deleted_at IS NULL;
  UPDATE public.payment_batches SET status='cancelled', delete_reason=p_reason WHERE id=p_batch_id;
  RETURN jsonb_build_object('id', p_batch_id, 'status', 'cancelled');
END $$;

-- ─────────────────────────────────────────────────────────────
-- 权限：仅 service_role / authenticated 可调(RLS 之外走 SECURITY DEFINER)
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE fn text; fns text[] := ARRAY[
  'create_payment_batch(uuid,text,date,text,text,text)',
  'add_payment_batch_line(uuid,uuid,numeric,uuid)',
  'remove_payment_batch_line(uuid,uuid,text)',
  'submit_payment_batch(uuid,uuid)',
  'approve_payment_batch(uuid,uuid)',
  'execute_batch_line_payment(uuid,uuid,text,date,text)',
  'close_payment_batch(uuid,uuid)',
  'cancel_payment_batch(uuid,uuid,text)'
];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', fn);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 自验证
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_proc WHERE proname IN (
    'create_payment_batch','add_payment_batch_line','remove_payment_batch_line',
    'submit_payment_batch','approve_payment_batch','execute_batch_line_payment',
    'close_payment_batch','cancel_payment_batch');
  IF v < 8 THEN RAISE EXCEPTION '排款 RPC 缺失 (count=%)', v; END IF;
  RAISE NOTICE '✓ 周排款子系统引擎层已就绪(8 个原子 RPC)';
END $$;
