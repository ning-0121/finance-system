-- rollback: 20260516_freeze_propagation
-- 注意：会还原 create_journal_atomic 到 Wave 1-A 末的版本（不含 freeze 检查）

DROP TRIGGER IF EXISTS trg_unfreeze_segregation ON public.entity_freezes;
DROP TRIGGER IF EXISTS trg_freeze_guard_shipping_documents ON public.shipping_documents;
DROP TRIGGER IF EXISTS trg_freeze_guard_actual_invoices ON public.actual_invoices;
DROP TRIGGER IF EXISTS trg_freeze_guard_cost_items ON public.cost_items;
DROP TRIGGER IF EXISTS trg_freeze_guard_order_settlements ON public.order_settlements;
DROP TRIGGER IF EXISTS trg_freeze_guard_payable_records ON public.payable_records;

DROP FUNCTION IF EXISTS public._admin_bypass_freeze_write(text, text, uuid);
DROP FUNCTION IF EXISTS public.trg_check_unfreeze_segregation();
DROP FUNCTION IF EXISTS public.trg_check_freeze_on_mutation();
DROP FUNCTION IF EXISTS public.financial_freeze_guard_with_parent(text, uuid, uuid);
DROP FUNCTION IF EXISTS public.financial_freeze_guard(text, uuid);

-- 还原 create_journal_atomic（保留 Wave 1-A 版本，不含 freeze 检查）
-- 参考: migrations/20260513_gl_balance_and_dup_guards.sql

CREATE OR REPLACE FUNCTION public.create_journal_atomic(
  p_period_code    text,
  p_date           date,
  p_description    text,
  p_source_type    text,
  p_source_id      uuid,
  p_total_debit    numeric,
  p_total_credit   numeric,
  p_voucher_type   text,
  p_created_by     uuid,
  p_lines          jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_journal_id   uuid;
  v_voucher_no   text;
  v_line         jsonb;
  v_line_no      integer := 1;
  v_period_status text;
BEGIN
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = p_period_code;
  IF v_period_status IS NULL THEN RAISE EXCEPTION '会计期间 % 不存在，请先创建该期间', p_period_code; END IF;
  IF v_period_status = 'closed' THEN RAISE EXCEPTION '会计期间 % 已关闭，不能写入凭证', p_period_code; END IF;
  IF ABS(p_total_debit - p_total_credit) > 0.001 THEN
    RAISE EXCEPTION '凭证借贷不平衡: 借方 % ≠ 贷方 %', p_total_debit, p_total_credit;
  END IF;

  INSERT INTO public.journal_entries (
    voucher_no, period_code, voucher_date, voucher_type, description,
    source_type, source_id, total_debit, total_credit, status,
    created_by, posted_by, posted_at
  ) VALUES (
    '', p_period_code, p_date, p_voucher_type, p_description,
    p_source_type, p_source_id, p_total_debit, p_total_credit, 'posted',
    p_created_by, p_created_by, now()
  ) RETURNING id, voucher_no INTO v_journal_id, v_voucher_no;

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
END $$;
