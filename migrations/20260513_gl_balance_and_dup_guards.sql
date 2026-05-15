-- ============================================================
-- 20260513 复杂场景验收发现的 P0 修复（需 DBA 执行）
-- 两处 DB 层 + 一处状态机协同：
--   (1) update_gl_balances trigger 未生效 → 凭证 posted 后 gl_balances 不更新
--       后果：试算平衡表、损益表、总账余额永远是 0
--   (2) actual_invoices 无 (supplier_name, invoice_no) 唯一约束 → 可重复入发票
--
-- 说明：原计划的 journal_entries (source_type, source_id) 唯一索引已移除——
-- 多次回款 / 多次付款是合法外贸场景（同一订单可分批回款），DB 层不该用
-- source_id 拦截。"同一发票重复付款" 的真实防线是：
--   (a) actual_invoices (supplier, invoice_no) UNIQUE — 拦截重复发票入库
--   (b) payable_records 状态机触发器 — paid 是终态，已付不能再付
--   (c) 应用层创建付款凭证前校验 payable_records.payment_status != 'paid'
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. 重建 create_journal_atomic RPC，把 gl_balances 写入嵌进内部
--    （旧版用 AFTER INSERT 触发器在 lines 插完之前就跑了，是 race condition）
-- ─────────────────────────────────────────────────────────────
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
  -- 1. 期间检查
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = p_period_code;
  IF v_period_status IS NULL THEN RAISE EXCEPTION '会计期间 % 不存在，请先创建该期间', p_period_code; END IF;
  IF v_period_status = 'closed' THEN RAISE EXCEPTION '会计期间 % 已关闭，不能写入凭证', p_period_code; END IF;

  -- 2. 借贷平衡校验
  IF ABS(p_total_debit - p_total_credit) > 0.001 THEN
    RAISE EXCEPTION '凭证借贷不平衡: 借方 % ≠ 贷方 %', p_total_debit, p_total_credit;
  END IF;

  -- 3. 插入凭证头
  INSERT INTO public.journal_entries (
    voucher_no, period_code, voucher_date, voucher_type, description,
    source_type, source_id, total_debit, total_credit, status,
    created_by, posted_by, posted_at
  ) VALUES (
    '', p_period_code, p_date, p_voucher_type, p_description,
    p_source_type, p_source_id, p_total_debit, p_total_credit, 'posted',
    p_created_by, p_created_by, now()
  )
  RETURNING id, voucher_no INTO v_journal_id, v_voucher_no;

  -- 4. 插入凭证明细行
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

  -- 5. ★ 关键修复：同一事务内更新 gl_balances（旧版用 trigger 在 lines 插完之前就跑了）
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

-- 移除有问题的旧 trigger（避免重复更新 gl_balances）
DROP TRIGGER IF EXISTS trg_update_gl ON public.journal_entries;

-- ─────────────────────────────────────────────────────────────
-- 2. actual_invoices 重复发票拦截
--    同一供应商 + 同一发票号 不能重复（软删后可重用号码）
-- ─────────────────────────────────────────────────────────────
-- 先清理潜在的历史重复（保留最早的一条），再加约束
WITH dup AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY supplier_name, invoice_no
    ORDER BY created_at ASC
  ) AS rn
  FROM public.actual_invoices
  WHERE supplier_name IS NOT NULL AND invoice_no IS NOT NULL
)
UPDATE public.actual_invoices SET status = 'voided'
WHERE id IN (SELECT id FROM dup WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_actual_invoices_supplier_invoice_no
  ON public.actual_invoices (supplier_name, invoice_no)
  WHERE status NOT IN ('voided', 'cancelled');

-- ─────────────────────────────────────────────────────────────
-- 3. 验证脚本
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_rpc_exists      boolean;
  v_void_trg_exists boolean;
  v_inv_idx_exists  boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'create_journal_atomic'
  ) INTO v_rpc_exists;
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_reverse_gl_on_void'
  ) INTO v_void_trg_exists;
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_actual_invoices_supplier_invoice_no'
  ) INTO v_inv_idx_exists;

  IF NOT v_rpc_exists      THEN RAISE EXCEPTION 'create_journal_atomic 未创建';     END IF;
  IF NOT v_void_trg_exists THEN RAISE EXCEPTION 'trg_reverse_gl_on_void 未创建';     END IF;
  IF NOT v_inv_idx_exists  THEN RAISE EXCEPTION 'uniq_actual_invoices_* 未创建';     END IF;

  RAISE NOTICE '✓ 20260513 修复迁移已就绪：RPC 内置 gl_balances + void 反向 + 发票唯一约束';
END $$;
