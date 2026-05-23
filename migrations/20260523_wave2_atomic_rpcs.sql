-- ============================================================
-- 20260523 Wave 2 · 两个原子 RPC 修复 P0-E1/E2
--
-- P0-E1: confirm_settlement_with_payables_atomic
--   旧：settlement.update→confirmed 后 for-loop 单条插 payable
--        中段失败 → settlement=confirmed + 部分 payable 缺失
--   新：单 plpgsql 函数 = 单事务，任一 INSERT 失败整体 rollback
--
-- P0-E2: record_customer_receipt_atomic
--   旧：executor 'update_receivable' 只插 actual_invoices(status='paid')，
--        无 GL → 收到客户钱但 trial balance 看不到现金 + AR 不对冲
--   新：subledger + 借记现金/贷记应收 单事务，借贷自动平衡
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- P0-E1 · confirm_settlement_with_payables_atomic
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.confirm_settlement_with_payables_atomic(
  p_settlement_id  uuid,
  p_actor_id       uuid,
  p_order_no       text,       -- 用于 payable.order_no 字段
  p_payables       jsonb       -- [{invoice_id, supplier_name, description, cost_category,
                               --   amount, currency, budget_amount, over_budget, due_date}]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_settlement       record;
  v_payable          jsonb;
  v_inserted_count   int := 0;
  v_existing_invoice_ids uuid[];
  v_settlement_after record;
BEGIN
  -- 1. 锁定决算单并校验状态 (FOR UPDATE 防止并发 confirm)
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

  -- 2. 收集已有应付的 invoice_id（防重复 — 应付 dedupe）
  SELECT array_agg(invoice_id) INTO v_existing_invoice_ids
  FROM public.payable_records
  WHERE budget_order_id = v_settlement.budget_order_id
    AND deleted_at IS NULL;

  -- 3. 逐条 INSERT — 任何一条失败 RAISE 整体 rollback
  FOR v_payable IN SELECT * FROM jsonb_array_elements(p_payables) LOOP
    -- 跳过已存在
    IF v_existing_invoice_ids IS NOT NULL
       AND (v_payable->>'invoice_id')::uuid = ANY(v_existing_invoice_ids) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.payable_records (
      budget_order_id, settlement_id, invoice_id, order_no,
      supplier_name, description, cost_category,
      amount, currency, budget_amount, over_budget, due_date,
      payment_status
    ) VALUES (
      v_settlement.budget_order_id, p_settlement_id, (v_payable->>'invoice_id')::uuid, p_order_no,
      coalesce(v_payable->>'supplier_name', '未知供应商'),
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
  END LOOP;

  -- 4. 仅在所有 INSERT 成功后才把 settlement 置 confirmed
  UPDATE public.order_settlements
  SET status = 'confirmed',
      settled_by = p_actor_id,
      settled_at = now()
  WHERE id = p_settlement_id;

  -- 5. 回读最终状态
  SELECT id, status, settled_at INTO v_settlement_after
  FROM public.order_settlements
  WHERE id = p_settlement_id;

  RETURN jsonb_build_object(
    'settlement_id',     v_settlement_after.id,
    'settlement_status', v_settlement_after.status,
    'settled_at',        v_settlement_after.settled_at,
    'payables_created',  v_inserted_count
  );
END $$;

COMMENT ON FUNCTION public.confirm_settlement_with_payables_atomic IS
'Wave 2 P0-E1: 决算确认 + 应付批量插入 单事务原子。任一应付 INSERT 失败 → 决算保持 draft，无 partial commit。';


-- ─────────────────────────────────────────────────────────────
-- P0-E2 · record_customer_receipt_atomic
--   子账态（actual_invoices type='customer_statement', status='paid'）
--   + 同事务 GL: Dr 银行/应收 Cr 应收账款
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_customer_receipt_atomic(
  p_budget_order_id  uuid,
  p_payer_name       text,
  p_amount           numeric,
  p_currency         text,
  p_transaction_date date,
  p_actor_id         uuid,
  p_invoice_no       text DEFAULT NULL,    -- 可选；缺则自动生成
  p_period_code      text DEFAULT NULL     -- 可选；缺则用 transaction_date 推
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_invoice_id    uuid;
  v_invoice_no    text;
  v_period_code   text;
  v_period_status text;
  v_journal       jsonb;
  v_cash_account  text := '100201';  -- 银行存款-人民币
  v_ar_account    text := '1122';    -- 应收账款
BEGIN
  -- 1. 决定期间
  v_period_code := coalesce(p_period_code, to_char(p_transaction_date, 'YYYY-MM'));
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = v_period_code;
  IF v_period_status IS NULL THEN
    RAISE EXCEPTION 'PERIOD_NOT_FOUND: 期间 % 不存在', v_period_code;
  END IF;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: 期间 % 已关闭，不能记账', v_period_code;
  END IF;

  -- 2. freeze 检查（订单冻结则拒）
  PERFORM public.financial_freeze_guard('budget_order', p_budget_order_id);

  -- 3. 插入 customer_statement subledger
  v_invoice_no := coalesce(p_invoice_no, 'RCV-' || to_char(now(), 'YYYYMMDDHH24MISS'));
  INSERT INTO public.actual_invoices (
    budget_order_id, invoice_type, invoice_no,
    supplier_name, total_amount, currency, status, invoice_date, created_by
  ) VALUES (
    p_budget_order_id, 'customer_statement', v_invoice_no,
    p_payer_name, p_amount, p_currency, 'paid', p_transaction_date, p_actor_id
  )
  RETURNING id INTO v_invoice_id;

  -- 4. 同事务 GL: Dr 银行 / Cr 应收
  --    若 freeze guard / period closed / lines insert 失败，整个函数 rollback (含 invoice)
  v_journal := public.create_journal_atomic(
    p_period_code   := v_period_code,
    p_date          := p_transaction_date,
    p_description   := format('客户回款 %s (%s)', p_payer_name, v_invoice_no),
    p_source_type   := 'customer_receipt',
    p_source_id     := v_invoice_id,
    p_total_debit   := p_amount,
    p_total_credit  := p_amount,
    p_voucher_type  := 'auto',
    p_created_by    := p_actor_id,
    p_lines         := jsonb_build_array(
      jsonb_build_object(
        'account_code', v_cash_account, 'debit', p_amount, 'credit', 0,
        'description', format('客户回款入账 %s', p_payer_name),
        'currency', p_currency, 'exchange_rate', 1,
        'order_id', p_budget_order_id
      ),
      jsonb_build_object(
        'account_code', v_ar_account, 'debit', 0, 'credit', p_amount,
        'description', format('冲减应收 %s', p_payer_name),
        'currency', p_currency, 'exchange_rate', 1,
        'order_id', p_budget_order_id
      )
    )
  );

  -- 5. 更新订单累计回款
  UPDATE public.budget_orders
  SET ar_received_amount = coalesce(ar_received_amount, 0) + p_amount,
      ar_received_at = now()
  WHERE id = p_budget_order_id;

  RETURN jsonb_build_object(
    'invoice_id', v_invoice_id,
    'invoice_no', v_invoice_no,
    'journal_id', v_journal->>'journal_id',
    'voucher_no', v_journal->>'voucher_no',
    'period_code', v_period_code,
    'amount', p_amount
  );
END $$;

COMMENT ON FUNCTION public.record_customer_receipt_atomic IS
'Wave 2 P0-E2: 客户回款 = subledger(customer_statement,paid) + GL(Dr Cash, Cr AR) + ar_received 累加，单事务原子。';


-- ─────────────────────────────────────────────────────────────
-- 自验证
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_proc
    WHERE proname IN ('confirm_settlement_with_payables_atomic', 'record_customer_receipt_atomic');
  IF v < 2 THEN RAISE EXCEPTION 'Wave 2 RPC 缺失 (count=%)', v; END IF;
  RAISE NOTICE '✓ Wave 2 atomic RPCs 已就绪';
END $$;
