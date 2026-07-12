-- ========================================================================
-- 20260712 统一应付口径 3b-1:决算派生应付去重改用 dedup_key(D1)
-- ========================================================================
-- 病(审计 F-2):confirm_settlement_with_payables_atomic 去重谓词是
--   (v_payable->>'invoice_id')::uuid = ANY(已存在 invoice_id),而 cost_items 派生的应付
--   invoice_id 恒 null → null=ANY(...) 恒 NULL → 去重永不命中。决算重跑 / 同键成本会重复建应付。
-- 修:改用 dedup_key(供应商|订单|金额|币种,与生成列同口径)——同订单下已存在同键的未删应付 → 跳过。
--   仅改去重、保留 20260712_rpc_actor_guard 补的角色门 + 真身 actor;业务逻辑不变。
-- ⚠️ 须先跑 20260712_rpc_actor_guard.sql 和 20260712_payable_dedup_key.sql。人工在财务库执行。
-- ========================================================================

CREATE OR REPLACE FUNCTION public.confirm_settlement_with_payables_atomic(p_settlement_id uuid, p_actor_id uuid, p_order_no text, p_payables jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_actor            uuid := public._finance_actor_guard(p_actor_id, ARRAY['finance_staff','finance_manager','admin']);
  v_settlement       record;
  v_payable          jsonb;
  v_inserted_count   int := 0;
  v_skipped_count    int := 0;
  v_existing_keys    text[];
  v_supplier         text;
  v_key              text;
  v_settlement_after record;
BEGIN
  SELECT * INTO v_settlement
  FROM public.order_settlements
  WHERE id = p_settlement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND: 决算单 % 不存在', p_settlement_id;
  END IF;
  IF v_settlement.status <> 'draft' THEN
    RAISE EXCEPTION 'SETTLEMENT_NOT_DRAFT: 决算单 % 当前 status=% 不可确认', p_settlement_id, v_settlement.status;
  END IF;
  IF v_settlement.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_DELETED: 决算单 % 已软删除', p_settlement_id;
  END IF;

  -- ★ 3b-1:收集本订单下已存在的应付去重键(dedup_key=供应商|订单|金额|币种,生成列)
  SELECT array_agg(dedup_key) INTO v_existing_keys
  FROM public.payable_records
  WHERE budget_order_id = v_settlement.budget_order_id
    AND deleted_at IS NULL;

  FOR v_payable IN SELECT * FROM jsonb_array_elements(p_payables) LOOP
    v_supplier := coalesce(v_payable->>'supplier_name', '未知供应商');
    -- 与生成列 dedup_key 完全同口径地拼本笔的键
    v_key := coalesce(lower(trim(v_supplier)), '') || '|' ||
             coalesce(v_settlement.budget_order_id::text, '') || '|' ||
             round((v_payable->>'amount')::numeric, 2)::text || '|' ||
             coalesce(upper(v_payable->>'currency'), '');

    IF v_existing_keys IS NOT NULL AND v_key = ANY(v_existing_keys) THEN
      v_skipped_count := v_skipped_count + 1;
      CONTINUE;   -- 同订单已有同键应付(采购对账已建/决算已派生)→ 不重复建
    END IF;

    INSERT INTO public.payable_records (
      budget_order_id, settlement_id, invoice_id, order_no,
      supplier_name, description, cost_category,
      amount, currency, budget_amount, over_budget, due_date,
      payment_status
    ) VALUES (
      v_settlement.budget_order_id, p_settlement_id, (v_payable->>'invoice_id')::uuid, p_order_no,
      v_supplier,
      coalesce(v_payable->>'description', ''),
      coalesce(v_payable->>'cost_category', 'other'),
      (v_payable->>'amount')::numeric,
      v_payable->>'currency',
      NULLIF(v_payable->>'budget_amount','')::numeric,
      coalesce((v_payable->>'over_budget')::boolean, false),
      NULLIF(v_payable->>'due_date','')::date,
      'unpaid'
    );
    v_inserted_count := v_inserted_count + 1;
    -- 新建的键并入已存在集合,防同一 p_payables 内的完全同键项重复(极少见,保守兜底)
    v_existing_keys := array_append(coalesce(v_existing_keys, ARRAY[]::text[]), v_key);
  END LOOP;

  UPDATE public.order_settlements
  SET status = 'confirmed',
      settled_by = v_actor,
      settled_at = now()
  WHERE id = p_settlement_id;

  SELECT id, status, settled_at INTO v_settlement_after
  FROM public.order_settlements
  WHERE id = p_settlement_id;

  RETURN jsonb_build_object(
    'settlement_id',     v_settlement_after.id,
    'settlement_status', v_settlement_after.status,
    'settled_at',        v_settlement_after.settled_at,
    'payables_created',  v_inserted_count,
    'payables_skipped',  v_skipped_count
  );
END $function$;

-- 验证:重复确认同一决算 / 同订单已有同键应付时,payables_skipped 应 > 0、不再重复建。
