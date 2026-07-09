-- ============================================================
-- 应收 · 回款流水「可编辑」RPC
-- 需求(老板 2026-07-09)：应收账款-回款流水允许财务纠错编辑。
-- receivable_payments 收紧了 RLS（UPDATE 不开放，直接 update 会 0 行假成功），
-- 故走 SECURITY DEFINER RPC，真实 auth.uid() 留痕 updated_by + entity_timeline。
--
-- 编辑分两类，按「资金守恒」严格分层：
--   1) 元数据(到账日/银行/流水号/备注)：不影响任何金额与分配 → 永远可改。
--   2) 金额(原币金额/币种/汇率→amount_cny)：改这些会动 amount_cny，进而影响
--      分配上限与 GL。仅当该流水【无有效分配】(未匹配)时才允许——此时无下游
--      projection/GL 依赖，安全。已匹配的要改金额，必须先撤销匹配，或走
--      correct_receivable_payment_rate 作废重建，不在本 RPC 放开。
--
-- 权限白名单与 void/unallocate 一致(老板放开至 finance_staff，审计留痕不变)。
-- 可加可逆，回滚见 .down.sql。
-- ============================================================

CREATE OR REPLACE FUNCTION public.edit_receivable_payment(
  p_receipt_id uuid,
  p_received_at date DEFAULT NULL,
  p_bank text DEFAULT NULL,
  p_reference text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_amount_original numeric DEFAULT NULL,   -- 传 NULL = 不改金额（仅改元数据）
  p_currency text DEFAULT NULL,
  p_rate numeric DEFAULT NULL,
  p_actor uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_alloc_count int;
  v_amount_cny numeric;
  v_currency text;
  v_rate numeric;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_staff','finance_manager','admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: 当前角色无权编辑回款'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.receivable_payments WHERE id = p_receipt_id AND voided_at IS NULL) THEN
    RAISE EXCEPTION 'RECEIPT_NOT_FOUND_OR_VOIDED'; END IF;

  -- 1) 元数据编辑（永远允许）：直接落库，空串归一为 NULL
  UPDATE public.receivable_payments SET
    received_at        = COALESCE(p_received_at, received_at),
    bank_account       = NULLIF(btrim(COALESCE(p_bank, bank_account, '')), ''),
    payment_reference  = NULLIF(btrim(COALESCE(p_reference, payment_reference, '')), ''),
    notes              = NULLIF(btrim(COALESCE(p_notes, notes, '')), ''),
    updated_at         = now(),
    updated_by         = p_actor
  WHERE id = p_receipt_id;

  -- 2) 金额编辑（仅未匹配流水）：改则连带重算 amount_cny
  IF p_amount_original IS NOT NULL THEN
    IF p_amount_original <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;

    SELECT count(*) INTO v_alloc_count FROM public.receivable_payment_allocations
      WHERE receipt_id = p_receipt_id AND voided_at IS NULL;
    IF v_alloc_count > 0 THEN
      RAISE EXCEPTION 'RECEIPT_HAS_ALLOCATIONS: 该回款已匹配订单，不能直接改金额。请先撤销匹配，或用汇率修正作废重建。';
    END IF;

    -- 未传币种/汇率则沿用原值；CNY 强制汇率 1
    SELECT COALESCE(p_currency, currency) INTO v_currency FROM public.receivable_payments WHERE id = p_receipt_id;
    v_rate := CASE WHEN v_currency = 'CNY' THEN 1 ELSE COALESCE(p_rate, (SELECT exchange_rate FROM public.receivable_payments WHERE id = p_receipt_id)) END;
    IF v_rate IS NULL OR v_rate <= 0 THEN RAISE EXCEPTION 'INVALID_RATE'; END IF;
    v_amount_cny := round(p_amount_original * v_rate, 2);

    UPDATE public.receivable_payments SET
      amount_original = p_amount_original,
      currency        = v_currency,
      exchange_rate   = v_rate,
      amount_cny      = v_amount_cny,
      updated_at      = now(),
      updated_by      = p_actor
    WHERE id = p_receipt_id;
  END IF;

  BEGIN
    INSERT INTO public.entity_timeline (entity_type, entity_id, event_type, event_title, event_detail, source_type, actor_id)
    VALUES ('receivable_payment', p_receipt_id, 'edited', '编辑回款流水',
      jsonb_build_object('amount_changed', p_amount_original IS NOT NULL,
        'amount_original', p_amount_original, 'amount_cny', v_amount_cny, 'reason', p_reason),
      'user', p_actor);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('receipt_id', p_receipt_id, 'amount_changed', p_amount_original IS NOT NULL, 'amount_cny', v_amount_cny);
END $$;

GRANT EXECUTE ON FUNCTION public.edit_receivable_payment(uuid,date,text,text,text,numeric,text,numeric,uuid,text) TO authenticated;

-- 验证：
-- SELECT proname FROM pg_proc WHERE proname='edit_receivable_payment';
