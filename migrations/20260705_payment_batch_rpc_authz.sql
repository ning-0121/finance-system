-- ============================================================
-- 周排款 RPC 鉴权加固(审计 P0-1)
--
-- 问题:8 个排款 RPC 全部 SECURITY DEFINER + GRANT authenticated,函数体内无任何
--   角色校验,且 approved_by/executed_by/submitted_by 直接写客户端传入的 p_actor →
--   finance_staff 可绕 UI 直接 rpc('approve_payment_batch',{p_actor:老板uuid}) 自审自
--   放款并伪造审批留痕,两步审批形同虚设。
--
-- 修法(照 20260608_receivable_role_enforcement 范式):
--   ① _finance_actor_guard(p_actor, roles):有 JWT(登录用户)则校验 _app_role ∈ roles,
--      不合规 RAISE FORBIDDEN,并返回**真实 auth.uid()**(记账用真人,杜绝冒名);
--      无 JWT(service_role 服务端调用)则信任 p_actor。
--   ② 每个 RPC 顶部过闸;写 actor 的列一律用返回的 v_actor,不再信任 p_actor。
--   ③ 角色分配:approve=finance_manager/admin(老板审批放款);其余=finance_staff+。
--
-- 仅重定义函数体,不动表/数据。可重复执行。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================

-- ── 鉴权+取真身 helper ──
CREATE OR REPLACE FUNCTION public._finance_actor_guard(p_actor uuid, p_roles text[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL THEN
    IF coalesce(public._app_role(), 'none') <> ALL(p_roles) THEN
      RAISE EXCEPTION 'FORBIDDEN: 当前角色无此操作权限(需 %)', array_to_string(p_roles, '/');
    END IF;
    RETURN v_uid;          -- 记录真实登录者,杜绝冒名
  END IF;
  RETURN p_actor;          -- 无 JWT = service_role 服务端调用,信任 p_actor
END $$;
REVOKE ALL ON FUNCTION public._finance_actor_guard(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._finance_actor_guard(uuid, text[]) TO authenticated, service_role;

-- 便捷常量:财务侧可操作角色 / 审批放款角色
--   staff+  = finance_staff / finance_manager / admin
--   mgr+    = finance_manager / admin

-- ── create_payment_batch(staff+) ──
CREATE OR REPLACE FUNCTION public.create_payment_batch(
  p_actor uuid, p_currency text, p_planned_pay_date date DEFAULT NULL,
  p_title text DEFAULT NULL, p_week_label text DEFAULT NULL, p_notes text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin']);
  v_date  date := coalesce(p_planned_pay_date, current_date);
  v_week  text := coalesce(p_week_label, to_char(v_date,'IYYY') || '-W' || to_char(v_date,'IW'));
  v_ccy   text := upper(coalesce(nullif(trim(p_currency),''),'CNY'));
  v_seq   int; v_no text; v_id uuid;
BEGIN
  SELECT coalesce(max(substring(batch_no from '[0-9]+$')::int),0)+1 INTO v_seq
  FROM public.payment_batches
  WHERE batch_no LIKE 'PR-'||to_char(v_date,'YYYYMMDD')||'-'||v_ccy||'-%';
  v_no := 'PR-'||to_char(v_date,'YYYYMMDD')||'-'||v_ccy||'-'||lpad(v_seq::text,2,'0');
  INSERT INTO public.payment_batches (batch_no, title, currency, week_label, planned_pay_date, status, created_by, notes)
  VALUES (v_no, p_title, v_ccy, v_week, p_planned_pay_date, 'draft', v_actor, p_notes)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'batch_no', v_no, 'currency', v_ccy, 'status', 'draft', 'week_label', v_week);
END $$;

-- ── add_payment_batch_line(staff+) ──
CREATE OR REPLACE FUNCTION public.add_payment_batch_line(
  p_batch_id uuid, p_payable_id uuid, p_pay_amount numeric, p_actor uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_batch record; v_payable record; v_reserved numeric; v_remaining numeric; v_pay numeric; v_line_id uuid;
BEGIN
  PERFORM public._finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin']);
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
    batch_id, payable_id, supplier_name, pay_amount, currency, payee_name, payee_account, payee_bank, status
  ) VALUES (
    p_batch_id, p_payable_id, v_payable.supplier_name, v_pay, v_batch.currency,
    v_payable.payee_name, v_payable.payee_account, v_payable.payee_bank, 'planned'
  ) RETURNING id INTO v_line_id;
  UPDATE public.payment_batches SET total_amount = total_amount + v_pay WHERE id = p_batch_id;
  RETURN jsonb_build_object('line_id', v_line_id, 'pay_amount', v_pay, 'remaining_before', v_remaining, 'payable_id', p_payable_id);
END $$;

-- ── remove_payment_batch_line(staff+) ──
CREATE OR REPLACE FUNCTION public.remove_payment_batch_line(p_line_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin']);
  v_line record; v_batch record;
BEGIN
  SELECT * INTO v_line FROM public.payment_batch_lines WHERE id = p_line_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINE_NOT_FOUND: 排款行不存在'; END IF;
  IF v_line.status = 'paid' THEN RAISE EXCEPTION 'LINE_PAID: 已付款的行不可移出'; END IF;
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = v_line.batch_id FOR UPDATE;
  IF v_batch.status <> 'draft' THEN
    RAISE EXCEPTION 'BATCH_NOT_DRAFT: 排款单已提交(status=%),行已锁定', v_batch.status;
  END IF;
  UPDATE public.payment_batch_lines
  SET deleted_at = now(), deleted_by = v_actor, delete_reason = p_reason, status = 'skipped'
  WHERE id = p_line_id;
  UPDATE public.payment_batches SET total_amount = greatest(total_amount - v_line.pay_amount, 0)
  WHERE id = v_line.batch_id;
  RETURN jsonb_build_object('line_id', p_line_id, 'removed', true);
END $$;

-- ── submit_payment_batch(staff+) ──
CREATE OR REPLACE FUNCTION public.submit_payment_batch(p_batch_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin']);
  v_batch record; v_n int;
BEGIN
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
  IF v_batch.status <> 'draft' THEN RAISE EXCEPTION 'BATCH_NOT_DRAFT: 当前 %,只有草稿可提交', v_batch.status; END IF;
  SELECT count(*) INTO v_n FROM public.payment_batch_lines WHERE batch_id = p_batch_id AND deleted_at IS NULL AND status IN ('planned','held');
  IF v_n < 1 THEN RAISE EXCEPTION 'EMPTY_BATCH: 排款单没有明细,不能提交'; END IF;
  UPDATE public.payment_batches SET status='submitted', submitted_by=v_actor, submitted_at=now() WHERE id=p_batch_id;
  RETURN jsonb_build_object('id', p_batch_id, 'status', 'submitted', 'lines', v_n);
END $$;

-- ── approve_payment_batch(mgr+ 老板审批放款) ──
CREATE OR REPLACE FUNCTION public.approve_payment_batch(p_batch_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := public._finance_actor_guard(p_actor, ARRAY['finance_manager','admin']);
  v_batch record;
BEGIN
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
  IF v_batch.status <> 'submitted' THEN RAISE EXCEPTION 'BATCH_NOT_SUBMITTED: 当前 %,只有已提交可审批', v_batch.status; END IF;
  -- 职责分离:审批人不能是本单提交人(除非 admin)
  IF v_batch.submitted_by IS NOT NULL AND v_batch.submitted_by = v_actor AND coalesce(public._app_role(),'none') <> 'admin' THEN
    RAISE EXCEPTION 'SEGREGATION: 不能审批自己提交的排款单(需他人审批)';
  END IF;
  UPDATE public.payment_batches SET status='approved', approved_by=v_actor, approved_at=now() WHERE id=p_batch_id;
  RETURN jsonb_build_object('id', p_batch_id, 'status', 'approved');
END $$;

-- ── execute_batch_line_payment(staff+ 出纳放款) ──
CREATE OR REPLACE FUNCTION public.execute_batch_line_payment(
  p_line_id uuid, p_actor uuid, p_payment_ref text, p_paid_at date DEFAULT NULL, p_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END $$;

-- ── close_payment_batch(staff+) ──
CREATE OR REPLACE FUNCTION public.close_payment_batch(p_batch_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_batch record;
BEGIN
  PERFORM public._finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin']);
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
  IF v_batch.status NOT IN ('approved','executing') THEN
    RAISE EXCEPTION 'BATCH_NOT_CLOSABLE: 当前 %,只有已审批/执行中可关单', v_batch.status;
  END IF;
  UPDATE public.payment_batch_lines SET status='skipped'
  WHERE batch_id=p_batch_id AND deleted_at IS NULL AND status IN ('planned','held');
  UPDATE public.payment_batches SET status='closed', closed_at=now() WHERE id=p_batch_id;
  RETURN jsonb_build_object('id', p_batch_id, 'status', 'closed');
END $$;

-- ── cancel_payment_batch(staff+) ──
CREATE OR REPLACE FUNCTION public.cancel_payment_batch(p_batch_id uuid, p_actor uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_batch record; v_paid int;
BEGIN
  PERFORM public._finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin']);
  SELECT * INTO v_batch FROM public.payment_batches WHERE id = p_batch_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND'; END IF;
  IF v_batch.status = 'closed' THEN RAISE EXCEPTION 'BATCH_CLOSED: 已关单不可作废'; END IF;
  SELECT count(*) INTO v_paid FROM public.payment_batch_lines WHERE batch_id=p_batch_id AND deleted_at IS NULL AND status='paid';
  IF v_paid > 0 THEN RAISE EXCEPTION 'HAS_PAID_LINES: 已有 % 行完成付款,不能作废(请改用关单)', v_paid; END IF;
  UPDATE public.payment_batch_lines SET status='skipped' WHERE batch_id=p_batch_id AND deleted_at IS NULL;
  UPDATE public.payment_batches SET status='cancelled', delete_reason=p_reason WHERE id=p_batch_id;
  RETURN jsonb_build_object('id', p_batch_id, 'status', 'cancelled');
END $$;

-- 自验证
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_proc WHERE proname = '_finance_actor_guard';
  IF v < 1 THEN RAISE EXCEPTION '缺 _finance_actor_guard'; END IF;
  RAISE NOTICE '✓ 排款 8 RPC 已加角色门 + 不信任 p_actor(approve=mgr+,余 staff+;actor 记真实登录者)';
END $$;
