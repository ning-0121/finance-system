-- ============================================================
-- 原子凭证写入 RPC
-- 将 journal_entries header + journal_lines 封装在单个事务中。
-- 消除"header 写成功但 lines 失败"导致的孤立凭证问题。
-- ============================================================

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
  p_lines          jsonb   -- [{account_code, description, debit, credit, currency, exchange_rate, original_amount, customer_id, supplier_name, order_id}]
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
  -- 1. 期间检查
  SELECT status INTO v_period_status
  FROM public.accounting_periods
  WHERE period_code = p_period_code;

  IF v_period_status IS NULL THEN
    RAISE EXCEPTION '会计期间 % 不存在，请先创建该期间', p_period_code;
  END IF;

  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION '会计期间 % 已关闭，不能写入凭证', p_period_code;
  END IF;

  -- 2. 借贷平衡校验
  IF ABS(p_total_debit - p_total_credit) > 0.001 THEN
    RAISE EXCEPTION '凭证借贷不平衡: 借方 % ≠ 贷方 %', p_total_debit, p_total_credit;
  END IF;

  -- 3. 插入凭证头（触发器自动填充 voucher_no）
  INSERT INTO public.journal_entries (
    voucher_no, period_code, voucher_date, voucher_type,
    description, source_type, source_id,
    total_debit, total_credit,
    status, created_by, posted_by, posted_at
  ) VALUES (
    '', p_period_code, p_date, p_voucher_type,
    p_description, p_source_type, p_source_id,
    p_total_debit, p_total_credit,
    'posted', p_created_by, p_created_by, now()
  )
  RETURNING id, voucher_no INTO v_journal_id, v_voucher_no;

  -- 4. 插入凭证明细行（同一事务内）
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    INSERT INTO public.journal_lines (
      journal_id, line_no, account_code, description,
      debit, credit, currency, exchange_rate, original_amount,
      customer_id, supplier_name, order_id
    ) VALUES (
      v_journal_id,
      v_line_no,
      v_line->>'account_code',
      v_line->>'description',
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

  -- 5. 返回结果（任何步骤失败整体回滚）
  RETURN jsonb_build_object(
    'journal_id', v_journal_id,
    'voucher_no', v_voucher_no
  );
END;
$$;

-- 仅允许已认证用户调用
REVOKE ALL ON FUNCTION public.create_journal_atomic FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_journal_atomic TO authenticated;

-- ============================================================
-- GL Void 补丁：作废凭证时反向更新 gl_balances
-- ============================================================

CREATE OR REPLACE FUNCTION public.reverse_gl_on_void()
RETURNS TRIGGER AS $$
BEGIN
  -- 仅当状态从 posted → voided 时触发
  IF NEW.status = 'voided' AND OLD.status = 'posted' THEN
    UPDATE public.gl_balances gb
    SET
      period_debit  = gb.period_debit  - jl.debit_sum,
      period_credit = gb.period_credit - jl.credit_sum,
      updated_at    = now()
    FROM (
      SELECT
        account_code,
        SUM(debit)  AS debit_sum,
        SUM(credit) AS credit_sum
      FROM public.journal_lines
      WHERE journal_id = NEW.id
      GROUP BY account_code
    ) jl
    WHERE gb.account_code = jl.account_code
      AND gb.period_code  = NEW.period_code;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reverse_gl_on_void ON public.journal_entries;
CREATE TRIGGER trg_reverse_gl_on_void
  AFTER UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.reverse_gl_on_void();

-- ============================================================
-- 状态机保护：budget_orders 非法转换 hard fail
-- ============================================================

CREATE OR REPLACE FUNCTION public.validate_budget_order_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- 合法转换表
  IF (OLD.status = 'draft'          AND NEW.status IN ('pending_review', 'draft'))    THEN RETURN NEW; END IF;
  IF (OLD.status = 'pending_review' AND NEW.status IN ('approved', 'rejected', 'pending_review', 'draft')) THEN RETURN NEW; END IF;
  IF (OLD.status = 'approved'       AND NEW.status IN ('closed', 'approved'))         THEN RETURN NEW; END IF;
  IF (OLD.status = 'rejected'       AND NEW.status IN ('draft', 'rejected'))          THEN RETURN NEW; END IF;
  IF (OLD.status = 'closed'         AND NEW.status = 'closed')                        THEN RETURN NEW; END IF;

  RAISE EXCEPTION '非法状态转换: budget_orders % → %（id: %）', OLD.status, NEW.status, NEW.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_budget_order_status ON public.budget_orders;
CREATE TRIGGER trg_budget_order_status
  BEFORE UPDATE ON public.budget_orders
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.validate_budget_order_status_transition();

-- ============================================================
-- Save Diagnostic 持久化日志表
-- ============================================================

CREATE TABLE IF NOT EXISTS public.save_diagnostic_logs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id      text,
  actor_id        text,
  source_page     text,
  api_route       text,
  table_name      text NOT NULL,
  record_id       text,
  action          text NOT NULL,  -- insert / update / delete / verify
  payload_hash    text,           -- sha256 of submitted payload
  db_hash         text,           -- sha256 of re-read payload
  status          text NOT NULL CHECK (status IN ('ok','mismatch','rls_blocked','not_found','error')),
  error_detail    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_save_diag_table    ON public.save_diagnostic_logs(table_name);
CREATE INDEX IF NOT EXISTS idx_save_diag_actor    ON public.save_diagnostic_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_save_diag_created  ON public.save_diagnostic_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_save_diag_status   ON public.save_diagnostic_logs(status) WHERE status != 'ok';

ALTER TABLE public.save_diagnostic_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_save_diag" ON public.save_diagnostic_logs
  FOR ALL USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
