-- ============================================================
-- 审计修复 P0-B：收款汇率修正事务化 RPC
-- 把"作废原流水 → 按新汇率重建 → 重新匹配"合并为单个 SECURITY DEFINER 事务，
-- 杜绝客户端三步中途失败留下"原流水已废、新流水没建"的中间态（应收暂时归零）。
-- 权限：作废属财务主管动作 → finance_manager/admin。
-- 复用既有 _refresh_order_ar_projection + entity_timeline，口径与 void/allocate 一致。
-- 可加可逆，回滚见 .down.sql
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
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_manager','admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: 汇率修正需财务主管权限'; END IF;
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

-- 验证：
-- SELECT proname FROM pg_proc WHERE proname='correct_receivable_payment_rate';
