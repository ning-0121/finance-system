-- ============================================================
-- 回款流水层 · 角色权威鉴权（不再只靠 UI）
--  • 角色校验写进 RPC 内部（绕过 UI 直接调 RPC 也拦得住）
--  • 收紧 RLS：人人可查；仅财务角色可直接「登记回款」(INSERT)；
--    分配表禁止直接写（一切匹配/撤销/作废只走 RPC）
--  • 服务端脚本(service role / auth.uid() 为空)豁免角色门，便于后台/验收脚本
--
-- 角色映射：
--   登记回款/收款/匹配  → finance_staff / finance_manager / admin
--   撤销匹配 / 作废回款   → finance_manager / admin
--   处理争议(disputed)   → admin
--
-- 依赖 20260607 已建表/触发器。可加可逆。回滚见 .down.sql
-- ============================================================

-- 当前登录用户业务角色
CREATE OR REPLACE FUNCTION public._app_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

-- ── RPC：匹配（财务员/经理/管理员）──
CREATE OR REPLACE FUNCTION public.allocate_receivable_payment(
  p_receipt_id uuid, p_budget_order_id uuid, p_amount_cny numeric,
  p_amount_original numeric DEFAULT NULL, p_actor uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_alloc_id uuid; v_voided timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_staff','finance_manager','admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: 当前角色无权匹配回款'; END IF;
  IF p_amount_cny IS NULL OR p_amount_cny<=0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  SELECT voided_at INTO v_voided FROM public.receivable_payments WHERE id=p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RECEIPT_NOT_FOUND'; END IF;
  IF v_voided IS NOT NULL THEN RAISE EXCEPTION 'RECEIPT_VOIDED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.budget_orders WHERE id=p_budget_order_id) THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  INSERT INTO public.receivable_payment_allocations (receipt_id, budget_order_id, amount_cny, amount_original, created_by)
    VALUES (p_receipt_id, p_budget_order_id, round(p_amount_cny,2), p_amount_original, p_actor) RETURNING id INTO v_alloc_id;
  PERFORM public._refresh_order_ar_projection(p_budget_order_id);
  BEGIN INSERT INTO public.entity_timeline (entity_type, entity_id, event_type, event_title, event_detail, source_type, actor_id)
    VALUES ('receivable_payment', p_receipt_id, 'allocate', '回款匹配到订单',
      jsonb_build_object('allocation_id',v_alloc_id,'budget_order_id',p_budget_order_id,'amount_cny',round(p_amount_cny,2)),'system',p_actor);
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN jsonb_build_object('allocation_id', v_alloc_id);
END $$;
GRANT EXECUTE ON FUNCTION public.allocate_receivable_payment(uuid,uuid,numeric,numeric,uuid) TO authenticated;

-- ── RPC：撤销匹配（经理/管理员）──
CREATE OR REPLACE FUNCTION public.unallocate_receivable_payment(
  p_allocation_id uuid, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_order uuid; v_receipt uuid; v_voided timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_manager','admin') THEN
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

-- ── RPC：作废回款（经理/管理员）──
CREATE OR REPLACE FUNCTION public.void_receivable_payment(
  p_receipt_id uuid, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r record;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_manager','admin') THEN
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

-- ── RPC：处理争议（仅管理员/财务负责人）── 标记或解除 disputed + 原因
CREATE OR REPLACE FUNCTION public.set_receivable_dispute(
  p_receipt_id uuid, p_disputed boolean, p_actor uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') <> 'admin' THEN
    RAISE EXCEPTION 'FORBIDDEN: 仅财务负责人可处理争议'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.receivable_payments WHERE id=p_receipt_id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND_OR_VOIDED'; END IF;
  IF p_disputed THEN
    UPDATE public.receivable_payments SET matched_status='disputed', dispute_reason=p_reason, updated_at=now(), updated_by=p_actor WHERE id=p_receipt_id;
  ELSE
    UPDATE public.receivable_payments SET dispute_reason=NULL, updated_at=now(), updated_by=p_actor WHERE id=p_receipt_id;
    PERFORM public._recalc_receipt_match(p_receipt_id);  -- 解除后按分配重算状态
  END IF;
  RETURN jsonb_build_object('receipt_id', p_receipt_id, 'disputed', p_disputed);
END $$;
GRANT EXECUTE ON FUNCTION public.set_receivable_dispute(uuid, boolean, uuid, text) TO authenticated;

-- ── 收紧 RLS ──
-- receivable_payments：SELECT 人人；INSERT 仅财务角色；UPDATE/DELETE 不开放(只走 RPC)
DROP POLICY IF EXISTS receivable_payments_ins ON public.receivable_payments;
DROP POLICY IF EXISTS receivable_payments_upd ON public.receivable_payments;
DROP POLICY IF EXISTS receivable_payments_del ON public.receivable_payments;
CREATE POLICY receivable_payments_ins ON public.receivable_payments FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
-- receivable_payment_allocations：禁止直接写（一切走 RPC，RPC 为 SECURITY DEFINER 绕过 RLS）
DROP POLICY IF EXISTS receivable_payment_allocations_ins ON public.receivable_payment_allocations;
DROP POLICY IF EXISTS receivable_payment_allocations_upd ON public.receivable_payment_allocations;
DROP POLICY IF EXISTS receivable_payment_allocations_del ON public.receivable_payment_allocations;

-- 验证：
-- SELECT proname FROM pg_proc WHERE proname IN ('_app_role','set_receivable_dispute');
-- SELECT policyname, cmd FROM pg_policies WHERE tablename='receivable_payments';
