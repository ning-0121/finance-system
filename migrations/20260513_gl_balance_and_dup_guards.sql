-- ============================================================
-- 20260513 复杂场景验收发现的 P0 修复（需 DBA 执行）
-- 三处问题：
--   (1) update_gl_balances trigger 未生效 → 凭证 posted 后 gl_balances 不更新
--       后果：试算平衡表、损益表、总账余额永远是 0
--   (2) actual_invoices 无 (supplier_name, invoice_no) 唯一约束 → 可重复入发票
--   (3) create_journal_atomic 不去重 (source_type, source_id) → 同笔付款可生成多张凭证
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. 重建总账余额更新触发器（确保已部署）
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_gl_balances()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'posted' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'posted') THEN
    INSERT INTO public.gl_balances (account_code, period_code, period_debit, period_credit)
    SELECT
      jl.account_code,
      NEW.period_code,
      SUM(jl.debit),
      SUM(jl.credit)
    FROM public.journal_lines jl
    WHERE jl.journal_id = NEW.id
    GROUP BY jl.account_code
    ON CONFLICT (account_code, period_code)
    DO UPDATE SET
      period_debit  = public.gl_balances.period_debit  + EXCLUDED.period_debit,
      period_credit = public.gl_balances.period_credit + EXCLUDED.period_credit,
      updated_at    = now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_gl ON public.journal_entries;
CREATE TRIGGER trg_update_gl
  AFTER INSERT OR UPDATE OF status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_gl_balances();

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
-- 3. 同一 payment source 不允许多张已 posted 凭证
--    source_type='payment' 时按 source_id 去重
-- ─────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uniq_journal_entries_payment_source
  ON public.journal_entries (source_type, source_id)
  WHERE status = 'posted' AND source_type IN ('payment', 'receipt');

-- ─────────────────────────────────────────────────────────────
-- 4. 验证脚本
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_trigger_exists boolean;
  v_dup_idx_exists boolean;
  v_pay_idx_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_update_gl'
  ) INTO v_trigger_exists;
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_actual_invoices_supplier_invoice_no'
  ) INTO v_dup_idx_exists;
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_journal_entries_payment_source'
  ) INTO v_pay_idx_exists;

  IF NOT v_trigger_exists THEN RAISE EXCEPTION 'trg_update_gl 未创建'; END IF;
  IF NOT v_dup_idx_exists THEN RAISE EXCEPTION 'uniq_actual_invoices_* 未创建'; END IF;
  IF NOT v_pay_idx_exists THEN RAISE EXCEPTION 'uniq_journal_entries_payment_source 未创建'; END IF;

  RAISE NOTICE '✓ 20260513 修复迁移已就绪：gl_balance 触发器 + 发票唯一约束 + 付款凭证去重';
END $$;
