-- ============================================================
-- 放开「收款结汇汇率修正」权限至财务专员（finance_staff）
-- 背景：原 RPC 把汇率修正视为主管动作(finance_manager/admin)，导致财务日常
--       录入实际结汇汇率(如 USD→CNY 6.77≠预算6.9)改不动、静默失败。
-- 决策(老板)：允许 finance_staff 也可修正（仍全程写审计：作废重建 + entity_timeline）。
-- 仅放宽第 27 行角色白名单，函数体其余逻辑与 20260618 版完全一致。
-- 可加可逆：回滚见 .down.sql（恢复为仅 finance_manager/admin）。
-- ============================================================

CREATE OR REPLACE FUNCTION public.correct_receivable_payment_rate(
  p_old_payment_id uuid,
  p_budget_order_id uuid,
  p_amount_original numeric,
  p_currency text,
  p_rate numeric,
  p_received_at date DEFAULT NULL,
  p_bank text DEFAULT NULL,
  p_actor uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_new_id uuid;
  v_alloc_id uuid;
  v_amount_cny numeric;
  r record;
BEGIN
  -- 放宽：财务专员/主管/管理员均可修正结汇汇率（仍写审计可追溯）
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_staff','finance_manager','admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: 汇率修正需财务权限'; END IF;
  IF p_amount_original IS NULL OR p_amount_original <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_rate IS NULL OR p_rate <= 0 THEN RAISE EXCEPTION 'INVALID_RATE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.receivable_payments WHERE id = p_old_payment_id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND_OR_VOIDED'; END IF;

  v_amount_cny := round(p_amount_original * p_rate, 2);

  -- 1) 作废原流水的全部有效分配 + 原流水本身（逐单回写 projection）
  FOR r IN SELECT id, budget_order_id FROM public.receivable_payment_allocations
           WHERE receipt_id = p_old_payment_id AND voided_at IS NULL LOOP
    UPDATE public.receivable_payment_allocations
      SET voided_at = now(), voided_by = p_actor, void_reason = COALESCE(p_reason, '汇率修正') WHERE id = r.id;
    PERFORM public._refresh_order_ar_projection(r.budget_order_id);
  END LOOP;
  UPDATE public.receivable_payments
    SET voided_at = now(), voided_by = p_actor, void_reason = COALESCE(p_reason, '汇率修正'),
        matched_status = 'unmatched', updated_at = now()
    WHERE id = p_old_payment_id;

  -- 2) 按新汇率重建流水（继承原流水的客户/来源/水单号）
  INSERT INTO public.receivable_payments
    (customer_id, customer_name, budget_order_id, amount_original, currency, exchange_rate, amount_cny,
     received_at, bank_account, payment_reference, source_type, notes, created_by)
  SELECT customer_id, customer_name, p_budget_order_id, p_amount_original, p_currency, p_rate, v_amount_cny,
         COALESCE(p_received_at, received_at), COALESCE(p_bank, bank_account), payment_reference, source_type,
         COALESCE(notes, '') || ' [汇率修正→' || p_rate || ']', p_actor
  FROM public.receivable_payments WHERE id = p_old_payment_id
  RETURNING id INTO v_new_id;

  -- 3) 重新匹配到订单（防超分配触发器仍生效）
  INSERT INTO public.receivable_payment_allocations (receipt_id, budget_order_id, amount_cny, amount_original, created_by)
    VALUES (v_new_id, p_budget_order_id, v_amount_cny, p_amount_original, p_actor) RETURNING id INTO v_alloc_id;
  PERFORM public._refresh_order_ar_projection(p_budget_order_id);

  BEGIN
    INSERT INTO public.entity_timeline (entity_type, entity_id, event_type, event_title, event_detail, source_type, actor_id)
    VALUES ('receivable_payment', v_new_id, 'rate_corrected', '收款汇率修正（作废重建）',
      jsonb_build_object('old_payment_id', p_old_payment_id, 'new_payment_id', v_new_id,
        'budget_order_id', p_budget_order_id, 'rate', p_rate, 'amount_cny', v_amount_cny, 'reason', p_reason),
      'user', p_actor);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('new_payment_id', v_new_id, 'allocation_id', v_alloc_id, 'amount_cny', v_amount_cny);
END $$;

GRANT EXECUTE ON FUNCTION public.correct_receivable_payment_rate(uuid,uuid,numeric,text,numeric,date,text,uuid,text) TO authenticated;

-- ============================================================
-- 同源 bug 修复：ar_received_amount projection 反推原币失真
-- 原实现 ar_received_amount = SUM(amount_cny) / 订单预算汇率——当实际结汇汇率
-- ≠ 预算汇率时，「已收原币」被算错（全额收的美金单会显示成"少收/有余额"）。
-- 改为：优先用分配的原币合计(amount_original，权威)；历史缺原币的分配回退按
-- 预算汇率近似（严格优于旧版对全部分配都用预算汇率反推）。CNY 单不受影响。
-- ============================================================
CREATE OR REPLACE FUNCTION public._refresh_order_ar_projection(p_order_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_orig numeric; v_last date; v_rate numeric;
BEGIN
  SELECT COALESCE(NULLIF(exchange_rate,0),1) INTO v_rate FROM public.budget_orders WHERE id = p_order_id;
  IF v_rate IS NULL THEN RETURN; END IF;  -- 订单不存在

  -- 已收原币：有 amount_original 用之(权威)，无则用 amount_cny/预算汇率近似
  SELECT COALESCE(SUM(COALESCE(a.amount_original, a.amount_cny / v_rate)),0), MAX(p.received_at)
    INTO v_orig, v_last
  FROM public.receivable_payment_allocations a
  JOIN public.receivable_payments p ON p.id = a.receipt_id
  WHERE a.budget_order_id = p_order_id AND a.voided_at IS NULL AND p.voided_at IS NULL;

  UPDATE public.budget_orders
     SET ar_received_amount = round(v_orig, 2),
         ar_received_at = v_last,
         updated_at = now()
   WHERE id = p_order_id;
END $$;
