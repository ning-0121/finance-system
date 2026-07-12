-- ========================================================================
-- 20260712 结算/过账/回款 RPC 补函数内角色门 + 真身 actor(审计 P0-B)
-- ========================================================================
-- 现状(体检确认 has_guard=false):confirm_settlement_with_payables_atomic /
--   create_journal_atomic / record_customer_receipt_atomic(两个重载)是 SECURITY DEFINER
--   + GRANT authenticated,函数体内无任何角色校验 —— 任何登录用户(sales/采购/出纳)可绕 UI
--   supabase.rpc(...) 直接建应付/过 GL/记回款(DEFINER 绕 RLS),且 actor 列写客户端传入的
--   p_actor 可伪造留痕。20260706_a1/a1b 只 REVOKE 了 anon,没补 guard。
-- 修法(照 20260705_payment_batch_rpc_authz 的 _finance_actor_guard 范式,与周排款 8 RPC 同源):
--   ① 函数顶部 v_actor := _finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin'])
--      —— 有 JWT 则校角色(非财务角色 RAISE FORBIDDEN)并返回真实 auth.uid();无 JWT(service_role
--      /触发器/嵌套调用)则信 p_actor,不破坏内部调用。
--   ② settled_by / created_by / posted_by 一律写 v_actor,不再信 p_actor。
-- 只加鉴权、不改任何业务逻辑(决算去重 bug 留批 3 随统一应付口径 D1 一并修)。
-- CREATE OR REPLACE 保留既有 GRANT/REVOKE(a1/a1b 已 REVOKE anon)。⚠️ 人工在财务库执行。
-- 回滚:重跑改前定义(见 .down.sql 说明)。
-- ========================================================================

-- ── ① 决算确认建应付 ──────────────────────────────────────────────────
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
  v_existing_invoice_ids uuid[];
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

  SELECT array_agg(invoice_id) INTO v_existing_invoice_ids
  FROM public.payable_records
  WHERE budget_order_id = v_settlement.budget_order_id
    AND deleted_at IS NULL;

  FOR v_payable IN SELECT * FROM jsonb_array_elements(p_payables) LOOP
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
    'payables_created',  v_inserted_count
  );
END $function$;

-- ── ② 过账原子 RPC ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_journal_atomic(p_period_code text, p_date date, p_description text, p_source_type text, p_source_id uuid, p_total_debit numeric, p_total_credit numeric, p_voucher_type text, p_created_by uuid, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_actor        uuid := public._finance_actor_guard(p_created_by, ARRAY['finance_staff','finance_manager','admin']);
  v_journal_id   uuid;
  v_voucher_no   text;
  v_line         jsonb;
  v_line_no      integer := 1;
  v_period_status text;
  v_order_id     uuid;
  v_distinct_orders uuid[];
BEGIN
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = p_period_code;
  IF v_period_status IS NULL THEN RAISE EXCEPTION '会计期间 % 不存在，请先创建该期间', p_period_code; END IF;
  IF v_period_status = 'closed' THEN RAISE EXCEPTION '会计期间 % 已关闭，不能写入凭证', p_period_code; END IF;

  IF ABS(p_total_debit - p_total_credit) > 0.001 THEN
    RAISE EXCEPTION '凭证借贷不平衡: 借方 % ≠ 贷方 %', p_total_debit, p_total_credit;
  END IF;

  SELECT array_agg(DISTINCT (line->>'order_id')::uuid)
  INTO v_distinct_orders
  FROM jsonb_array_elements(p_lines) AS line
  WHERE line->>'order_id' IS NOT NULL;

  IF v_distinct_orders IS NOT NULL THEN
    FOREACH v_order_id IN ARRAY v_distinct_orders LOOP
      PERFORM public.financial_freeze_guard('budget_order', v_order_id);
    END LOOP;
  END IF;
  IF p_source_type IN ('budget_order', 'budget_orders') THEN
    PERFORM public.financial_freeze_guard('budget_order', p_source_id);
  ELSIF p_source_type IN ('actual_invoice') THEN
    PERFORM public.financial_freeze_guard('actual_invoice', p_source_id);
  ELSIF p_source_type IN ('payable_record', 'payment') THEN
    PERFORM public.financial_freeze_guard('payable_record', p_source_id);
  END IF;

  INSERT INTO public.journal_entries (
    voucher_no, period_code, voucher_date, voucher_type, description,
    source_type, source_id, total_debit, total_credit, status,
    created_by, posted_by, posted_at
  ) VALUES (
    '', p_period_code, p_date, p_voucher_type, p_description,
    p_source_type, p_source_id, p_total_debit, p_total_credit, 'posted',
    v_actor, v_actor, now()
  )
  RETURNING id, voucher_no INTO v_journal_id, v_voucher_no;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO public.journal_lines (
      journal_id, line_no, account_code, description,
      debit, credit, currency, exchange_rate, original_amount,
      customer_id, supplier_name, order_id
    ) VALUES (
      v_journal_id, v_line_no, v_line->>'account_code', v_line->>'description',
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      COALESCE(v_line->>'currency', 'CNY'),
      COALESCE((v_line->>'exchange_rate')::numeric, 1),
      (v_line->>'original_amount')::numeric,
      (v_line->>'customer_id')::uuid,
      v_line->>'supplier_name',
      (v_line->>'order_id')::uuid
    );
    v_line_no := v_line_no + 1;
  END LOOP;

  INSERT INTO public.gl_balances (account_code, period_code, period_debit, period_credit)
  SELECT jl.account_code, p_period_code, SUM(jl.debit), SUM(jl.credit)
  FROM public.journal_lines jl
  WHERE jl.journal_id = v_journal_id
  GROUP BY jl.account_code
  ON CONFLICT (account_code, period_code) DO UPDATE SET
    period_debit  = public.gl_balances.period_debit  + EXCLUDED.period_debit,
    period_credit = public.gl_balances.period_credit + EXCLUDED.period_credit,
    updated_at    = now();

  RETURN jsonb_build_object('journal_id', v_journal_id, 'voucher_no', v_voucher_no);
END $function$;

-- ── ③ 回款原子 RPC（重载1:无 p_exchange_rate,历史签名)──────────────────
CREATE OR REPLACE FUNCTION public.record_customer_receipt_atomic(p_budget_order_id uuid, p_payer_name text, p_amount numeric, p_currency text, p_transaction_date date, p_actor_id uuid, p_invoice_no text DEFAULT NULL::text, p_period_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_actor         uuid := public._finance_actor_guard(p_actor_id, ARRAY['finance_staff','finance_manager','admin']);
  v_invoice_id    uuid;
  v_invoice_no    text;
  v_period_code   text;
  v_period_status text;
  v_journal       jsonb;
  v_cash_account  text := '100201';
  v_ar_account    text := '1122';
BEGIN
  v_period_code := coalesce(p_period_code, to_char(p_transaction_date, 'YYYY-MM'));
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = v_period_code;
  IF v_period_status IS NULL THEN
    RAISE EXCEPTION 'PERIOD_NOT_FOUND: 期间 % 不存在', v_period_code;
  END IF;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: 期间 % 已关闭，不能记账', v_period_code;
  END IF;

  PERFORM public.financial_freeze_guard('budget_order', p_budget_order_id);

  v_invoice_no := coalesce(p_invoice_no, 'RCV-' || to_char(now(), 'YYYYMMDDHH24MISS'));
  INSERT INTO public.actual_invoices (
    budget_order_id, invoice_type, invoice_no,
    supplier_name, total_amount, currency, status, invoice_date, created_by
  ) VALUES (
    p_budget_order_id, 'customer_statement', v_invoice_no,
    p_payer_name, p_amount, p_currency, 'paid', p_transaction_date, v_actor
  )
  RETURNING id INTO v_invoice_id;

  v_journal := public.create_journal_atomic(
    p_period_code   := v_period_code,
    p_date          := p_transaction_date,
    p_description   := format('客户回款 %s (%s)', p_payer_name, v_invoice_no),
    p_source_type   := 'customer_receipt',
    p_source_id     := v_invoice_id,
    p_total_debit   := p_amount,
    p_total_credit  := p_amount,
    p_voucher_type  := 'auto',
    p_created_by    := v_actor,
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
END $function$;

-- ── ③ 回款原子 RPC（重载2:带 p_exchange_rate,当前主用签名)──────────────
CREATE OR REPLACE FUNCTION public.record_customer_receipt_atomic(p_budget_order_id uuid, p_payer_name text, p_amount numeric, p_currency text, p_transaction_date date, p_actor_id uuid, p_invoice_no text DEFAULT NULL::text, p_period_code text DEFAULT NULL::text, p_exchange_rate numeric DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_actor         uuid := public._finance_actor_guard(p_actor_id, ARRAY['finance_staff','finance_manager','admin']);
  v_invoice_id    uuid;
  v_invoice_no    text;
  v_period_code   text;
  v_period_status text;
  v_journal       jsonb;
  v_ccy           text := upper(coalesce(nullif(trim(p_currency),''),'CNY'));
  v_rate          numeric := coalesce(nullif(p_exchange_rate,0), 1);
  v_amt_cny       numeric := round(p_amount * coalesce(nullif(p_exchange_rate,0), 1), 2);
  v_cash_account  text;
  v_ar_account    text := '1122';
BEGIN
  v_cash_account := CASE WHEN v_ccy = 'CNY' THEN '100201' ELSE '100202' END;

  v_period_code := coalesce(p_period_code, to_char(p_transaction_date, 'YYYY-MM'));
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = v_period_code;
  IF v_period_status IS NULL THEN
    RAISE EXCEPTION 'PERIOD_NOT_FOUND: 期间 % 不存在', v_period_code;
  END IF;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: 期间 % 已关闭，不能记账', v_period_code;
  END IF;

  PERFORM public.financial_freeze_guard('budget_order', p_budget_order_id);

  v_invoice_no := coalesce(p_invoice_no, 'RCV-' || to_char(now(), 'YYYYMMDDHH24MISS'));
  INSERT INTO public.actual_invoices (
    budget_order_id, invoice_type, invoice_no,
    supplier_name, total_amount, currency, status, invoice_date, created_by
  ) VALUES (
    p_budget_order_id, 'customer_statement', v_invoice_no,
    p_payer_name, p_amount, v_ccy, 'paid', p_transaction_date, v_actor
  )
  RETURNING id INTO v_invoice_id;

  v_journal := public.create_journal_atomic(
    p_period_code   := v_period_code,
    p_date          := p_transaction_date,
    p_description   := format('客户回款 %s (%s) %s%s @%s', p_payer_name, v_invoice_no, v_ccy, p_amount, v_rate),
    p_source_type   := 'customer_receipt',
    p_source_id     := v_invoice_id,
    p_total_debit   := v_amt_cny,
    p_total_credit  := v_amt_cny,
    p_voucher_type  := 'auto',
    p_created_by    := v_actor,
    p_lines         := jsonb_build_array(
      jsonb_build_object(
        'account_code', v_cash_account, 'debit', v_amt_cny, 'credit', 0,
        'description', format('客户回款入账 %s (%s%s@%s)', p_payer_name, v_ccy, p_amount, v_rate),
        'currency', v_ccy, 'exchange_rate', v_rate,
        'order_id', p_budget_order_id
      ),
      jsonb_build_object(
        'account_code', v_ar_account, 'debit', 0, 'credit', v_amt_cny,
        'description', format('冲减应收 %s', p_payer_name),
        'currency', v_ccy, 'exchange_rate', v_rate,
        'order_id', p_budget_order_id
      )
    )
  );

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
    'amount', p_amount,
    'amount_cny', v_amt_cny,
    'exchange_rate', v_rate,
    'currency', v_ccy
  );
END $function$;

-- 验证:
--   select proname,(prosrc ilike '%_finance_actor_guard%') has_guard from pg_proc
--   where proname in ('confirm_settlement_with_payables_atomic','create_journal_atomic','record_customer_receipt_atomic');
--   期望全部 has_guard=true(record_customer_receipt 两行都 true)。
