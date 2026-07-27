-- ============================================================
-- 客户回款 FX 结构性护栏(全面审计 2026-07-27 · P0-1 收尾)
--
-- 背景:record_customer_receipt_atomic 是【直接过账真实账】的 RPC(Dr 银行/Cr 应收,立即 posted)。
--   现状:v_rate := coalesce(nullif(p_exchange_rate,0), 1) —— 外币若传 0/空汇率,会静默按 1:1 折 CNY,
--   导致银行存款虚增、应收冲不平、试算表现金与应收双双失真(约差一个汇率倍数)。
--
-- 只读诊断(2026-07-27)结论:receivable_payments 存活 10 笔,外币按 1/0/空汇率 = 0 笔 → 当前未发作。
--   且两个调用方均已在应用层拦截:回款UI(receivables/page.tsx:361 外币 effRate<=0 报错)、
--   文档执行引擎(executor.ts:444-450 外币缺汇率 throw)。
--   本迁移是 SECURITY DEFINER RPC 的【结构性最后一道防线】:防未来新调用方 / 直连 RPC 绕过应用层。
--
-- 修法:仅在函数体开头加一个护栏 —— 外币(非 CNY)且汇率缺失/为 0 → RAISE 拒绝,不再兜底 1。
--   函数其余逻辑与 20260705_customer_receipt_fx.sql 完全一致;CNY 回款(rate 默认 1)不受影响。
--   加固、可重复执行、可回滚(见 .down.sql)。
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
  p_exchange_rate    numeric DEFAULT 1     -- 结汇/入账汇率(原币→CNY);CNY 回款传 1
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
  v_amt_cny       numeric := round(p_amount * coalesce(nullif(p_exchange_rate,0), 1), 2);  -- 折 CNY 记账
  v_cash_account  text;
  v_ar_account    text := '1122';    -- 应收账款
BEGIN
  -- ★ 护栏(2026-07-27 审计):外币回款必须带有效汇率,禁止静默按 1:1 折 CNY 入账。
  --   RAISE 会中止整个事务,在任何 INSERT/GL 之前拦下,不产生任何脏账。
  IF v_ccy <> 'CNY' AND coalesce(nullif(p_exchange_rate, 0), 0) = 0 THEN
    RAISE EXCEPTION 'FX_RATE_REQUIRED: 外币回款(%)必须提供有效结汇汇率,不能按 1:1 入账', v_ccy
      USING HINT = '请在单据或订单上补录结汇汇率后重试';
  END IF;

  -- 现金科目按币种:CNY→银行存款人民币;其他→银行存款外币
  v_cash_account := CASE WHEN v_ccy = 'CNY' THEN '100201' ELSE '100202' END;

  -- 1. 决定期间
  v_period_code := coalesce(p_period_code, to_char(p_transaction_date, 'YYYY-MM'));
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = v_period_code;
  IF v_period_status IS NULL THEN
    RAISE EXCEPTION 'PERIOD_NOT_FOUND: 期间 % 不存在', v_period_code;
  END IF;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: 期间 % 已关闭，不能记账', v_period_code;
  END IF;

  -- 2. freeze 检查
  PERFORM public.financial_freeze_guard('budget_order', p_budget_order_id);

  -- 3. 插入 customer_statement subledger(金额记原币,汇率单列)
  v_invoice_no := coalesce(p_invoice_no, 'RCV-' || to_char(now(), 'YYYYMMDDHH24MISS'));
  INSERT INTO public.actual_invoices (
    budget_order_id, invoice_type, invoice_no,
    supplier_name, total_amount, currency, status, invoice_date, created_by
  ) VALUES (
    p_budget_order_id, 'customer_statement', v_invoice_no,
    p_payer_name, p_amount, v_ccy, 'paid', p_transaction_date, p_actor_id
  )
  RETURNING id INTO v_invoice_id;

  -- 4. 同事务 GL: Dr 银行(按币种科目) / Cr 应收 —— 金额一律折 CNY,借贷自动平衡
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

  -- 5. 更新订单累计回款(原币口径,同既有)
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

DO $do$ BEGIN RAISE NOTICE '✓ 客户回款 RPC 已加外币汇率护栏(外币缺汇率一律拒绝,不再静默 1:1)'; END $do$;
