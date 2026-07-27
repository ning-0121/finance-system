-- ============================================================
-- 回滚:去掉客户回款外币汇率护栏,恢复 20260705_customer_receipt_fx.sql 的函数体
--   (外币缺汇率会再次静默按 1:1 折 CNY —— 仅用于紧急回退)
-- ⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_customer_receipt_atomic(
  p_budget_order_id  uuid,
  p_payer_name       text,
  p_amount           numeric,
  p_currency         text,
  p_transaction_date date,
  p_actor_id         uuid,
  p_invoice_no       text DEFAULT NULL,
  p_period_code      text DEFAULT NULL,
  p_exchange_rate    numeric DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
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
    p_payer_name, p_amount, v_ccy, 'paid', p_transaction_date, p_actor_id
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
    p_created_by    := p_actor_id,
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
END $fn$;
