-- ========================================================================
-- 20260711 应付状态机 × 周排款放款 修复 + 紧急付款支撑
-- ========================================================================
-- 根因(用户实测):周排款出纳放款报「非法状态转换: payable_records.payment_status unpaid → paid」。
--   20260511 建的状态机只认 unpaid→pending_approval→approved→paid;
--   20260705 周排款上线时只把 partially_paid 加进 CHECK,触发器没同步 ——
--   ① 没先在付款审批页点过「审批」的应付,周排款放款必失败(本次 ¥3000 定金);
--   ② 部分付(approved→partially_paid / partially_paid→paid)从来就会被拦(潜伏 bug)。
-- 修法(不开后门):
--   1) 触发器补 partially_paid 的合法转换(approved→partially_paid, partially_paid→paid)。
--   2) execute_batch_line_payment 放款前把应付按状态机【逐步推进】到 approved ——
--      依据:排款单本身已由老板 approve_payment_batch 审批(角色+职责分离都校验过),
--      批准排款单即视为单内应付的付款审批;推进时记 approved_at 留痕。
--      未经审批的排款单依然付不出去(BATCH_NOT_APPROVED 拦着),控制不弱化。
-- 纯函数替换,无表结构变更。⚠️ 人工在财务库执行。回滚见 .down.sql。
-- ========================================================================

-- 1) 状态机触发器:补 partially_paid(其余保持 20260511 原样,paid 仍是终态)
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
    (v_old = 'approved'         AND v_new IN ('paid', 'partially_paid', 'cancelled')) OR
    (v_old = 'partially_paid'   AND v_new = 'paid') OR                         -- 分批付清
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

-- 2) 出纳放款:付款前按状态机逐步推进应付到 approved(排款单已获老板审批 → 视为应付付款审批,记留痕)
CREATE OR REPLACE FUNCTION public.execute_batch_line_payment(
  p_line_id uuid, p_actor uuid, p_payment_ref text, p_paid_at date DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_actor uuid := public._finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin']);
  v_line record; v_batch record; v_payable record; v_new_paid numeric; v_status text; v_pay_id uuid; v_left int;
BEGIN
  SELECT * INTO v_line FROM public.payment_batch_lines WHERE id = p_line_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINE_NOT_FOUND: 排款行不存在'; END IF;
  IF v_line.status = 'paid' THEN RAISE EXCEPTION 'ALREADY_PAID: 该行已付款(executed_at=%),不可重复执行', v_line.executed_at; END IF;
  IF v_line.status <> 'planned' THEN RAISE EXCEPTION 'LINE_NOT_PAYABLE: 行状态 %,不可执行', v_line.status; END IF;
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = v_line.batch_id FOR UPDATE;
  IF v_batch.status NOT IN ('approved','executing') THEN
    RAISE EXCEPTION 'BATCH_NOT_APPROVED: 排款单 status=%,未审批放款不能付款', v_batch.status;
  END IF;
  SELECT * INTO v_payable FROM public.payable_records WHERE id = v_line.payable_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYABLE_NOT_FOUND'; END IF;
  v_new_paid := coalesce(v_payable.paid_amount,0) + v_line.pay_amount;
  IF v_new_paid > v_payable.amount + 0.005 THEN
    RAISE EXCEPTION 'OVERPAY: 累计已付 % 将超应付额 %(本次%)', v_new_paid, v_payable.amount, v_line.pay_amount;
  END IF;
  -- 应付审批推进(修 2026-07-11「unpaid → paid 非法转换」):排款单已由老板审批,
  -- 该应付视为已获付款审批 —— 按状态机逐步走到 approved,记 approved_at 留痕,不绕过状态机。
  IF v_payable.payment_status = 'unpaid' THEN
    UPDATE public.payable_records SET payment_status='pending_approval' WHERE id = v_payable.id;
    UPDATE public.payable_records SET payment_status='approved', approved_at=coalesce(approved_at, now()) WHERE id = v_payable.id;
  ELSIF v_payable.payment_status = 'pending_approval' THEN
    UPDATE public.payable_records SET payment_status='approved', approved_at=coalesce(approved_at, now()) WHERE id = v_payable.id;
  END IF;
  BEGIN
    INSERT INTO public.supplier_payments (
      supplier_name, amount, currency, paid_at, note, payment_ref, source_batch_line_id, created_by
    ) VALUES (
      v_line.supplier_name, v_line.pay_amount, v_line.currency, coalesce(p_paid_at, current_date),
      coalesce(p_note, '排款单 '||v_batch.batch_no||' 执行付款'), nullif(trim(p_payment_ref),''), p_line_id, v_actor
    ) RETURNING id INTO v_pay_id;
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM ILIKE '%batch_line%' THEN
      RAISE EXCEPTION 'ALREADY_PAID: 该排款行已生成过实付,不可重复付款';
    ELSIF SQLERRM ILIKE '%supplier_ref%' THEN
      RAISE EXCEPTION 'DUP_REF: 凭证号「%」在供应商 % 下已登记过付款,不可重复付款', p_payment_ref, v_line.supplier_name;
    ELSE RAISE; END IF;
  END;
  v_status := CASE WHEN v_new_paid >= v_payable.amount - 0.005 THEN 'paid' ELSE 'partially_paid' END;
  UPDATE public.payable_records
  SET paid_amount = v_new_paid, payment_status = v_status,
      paid_at = coalesce(paid_at, coalesce(p_paid_at::timestamptz, now())),   -- 审计P2:用出纳录入的付款日
      payment_reference = coalesce(nullif(trim(p_payment_ref),''), payment_reference),
      payment_method = coalesce(payment_method, 'bank_transfer')
  WHERE id = v_payable.id;
  UPDATE public.payment_batch_lines
  SET status='paid', payment_id=v_pay_id, payment_ref=nullif(trim(p_payment_ref),''), executed_at=now(), executed_by=v_actor
  WHERE id = p_line_id;
  SELECT count(*) INTO v_left FROM public.payment_batch_lines
  WHERE batch_id = v_batch.id AND deleted_at IS NULL AND status IN ('planned','held');
  UPDATE public.payment_batches
  SET paid_total = paid_total + v_line.pay_amount,
      status = CASE WHEN v_left = 0 THEN 'closed' ELSE 'executing' END,
      closed_at = CASE WHEN v_left = 0 THEN now() ELSE closed_at END
  WHERE id = v_batch.id;
  RETURN jsonb_build_object('payment_id', v_pay_id, 'line_id', p_line_id, 'payable_id', v_payable.id,
    'paid_amount', v_new_paid, 'payable_status', v_status,
    'batch_status', CASE WHEN v_left = 0 THEN 'closed' ELSE 'executing' END);
END $fn$;

-- 验证:
--   SELECT 1;  -- 之后到周排款页对卡住的行重新点「放款」应成功
-- ========================================================================
