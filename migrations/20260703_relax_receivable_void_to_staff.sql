-- ============================================================
-- 放开「撤销回款匹配 / 作废回款」权限至财务专员（finance_staff）
-- 背景(老板决策)：删除/作废类操作原先仅财务主管/管理员，管理员登录不便，
--   财务日常纠错被卡。临时放开至 finance_staff——全程审计留痕不变
--   (voided_by/void_reason/entity_timeline)，可随时回滚收紧。
-- 仅放宽两个函数的角色白名单，其余逻辑与 20260608 版完全一致。
-- 「处理争议」仍仅 admin，不放开。回滚见 .down.sql。
-- ============================================================

CREATE OR REPLACE FUNCTION public.unallocate_receivable_payment(
  p_allocation_id uuid, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_order uuid; v_receipt uuid; v_voided timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_staff','finance_manager','admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: 当前角色无权撤销匹配'; END IF;
  SELECT budget_order_id, receipt_id, voided_at INTO v_order, v_receipt, v_voided
    FROM public.receivable_payment_allocations WHERE id=p_allocation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ALLOCATION_NOT_FOUND'; END IF;
  IF v_voided IS NOT NULL THEN RAISE EXCEPTION 'ALREADY_VOIDED'; END IF;
  UPDATE public.receivable_payment_allocations SET voided_at=now(), voided_by=p_actor, void_reason=p_reason WHERE id=p_allocation_id;
  PERFORM public._refresh_order_ar_projection(v_order);
  BEGIN INSERT INTO public.entity_timeline (entity_type, entity_id, event_type, event_title, event_detail, source_type, actor_id)
    VALUES ('receivable_payment', v_receipt, 'unallocate', '撤销回款匹配',
      jsonb_build_object('allocation_id',p_allocation_id,'budget_order_id',v_order,'reason',p_reason),'system',p_actor);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('allocation_id', p_allocation_id, 'voided', true);
END $$;
GRANT EXECUTE ON FUNCTION public.unallocate_receivable_payment(uuid,uuid,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_receivable_payment(
  p_receipt_id uuid, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r record;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_staff','finance_manager','admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: 当前角色无权作废回款'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.receivable_payments WHERE id=p_receipt_id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND_OR_VOIDED'; END IF;
  FOR r IN SELECT id, budget_order_id FROM public.receivable_payment_allocations
           WHERE receipt_id=p_receipt_id AND voided_at IS NULL LOOP
    UPDATE public.receivable_payment_allocations SET voided_at=now(), voided_by=p_actor, void_reason=COALESCE(p_reason,'receipt voided') WHERE id=r.id;
    PERFORM public._refresh_order_ar_projection(r.budget_order_id);
  END LOOP;
  UPDATE public.receivable_payments SET voided_at=now(), voided_by=p_actor, void_reason=p_reason, matched_status='unmatched', updated_at=now() WHERE id=p_receipt_id;
  RETURN jsonb_build_object('receipt_id', p_receipt_id, 'voided', true);
END $$;
GRANT EXECUTE ON FUNCTION public.void_receivable_payment(uuid,uuid,text) TO authenticated;
