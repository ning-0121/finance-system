-- ============================================================
-- GL 受控灰度（Controlled Gray-Release）基础设施
--
-- 目标：业务事件不再「直接 posted」，而是：
--   业务保存成功 → 入 gl_posting_queue（仅排队，不阻塞业务）
--   → worker/API 处理 → 默认生成 status='draft' 凭证（requires_review=true）
--   → 财务经理 review 后才 post_journal 转 posted（此时才影响 gl_balances）
--
-- 仅当 GL_AUTO_POST_ENABLED=true 且金额低于阈值等低风险条件，才允许自动 posted。
--
-- 本迁移全部「可加可逆」：CREATE TABLE/COLUMN IF NOT EXISTS、CREATE OR REPLACE。
-- 不改动既有 create_journal_atomic / journal_entries 的 status CHECK。
-- 回滚见 20260529_gl_gray_release.down.sql
-- ============================================================

-- ── 1. GL 过账队列 ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gl_posting_queue (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_type         text NOT NULL,                 -- budget_order / settlement / receipt / supplier_payment
  source_id           uuid NOT NULL,
  business_event      text NOT NULL,                 -- order_approved / settlement_confirmed / receipt_saved / payment_registered
  target_journal_type text NOT NULL,                 -- revenue_recognition / cost_recognition / ar_receipt / ap_payment
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','draft_created','posted','failed','skipped')),
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  last_error_code     text,                          -- MISSING_RATE / PERIOD_CLOSED / ACCOUNT_MISSING / UNBALANCED / RPC_FAILED / RLS_FAILED / FREEZE_BLOCKED / DUPLICATE_SOURCE / MISSING_SOURCE_DOC
  next_retry_at       timestamptz,
  requires_review     boolean NOT NULL DEFAULT true,
  amount_cny          numeric(15,2),                 -- 便于阈值判断与控制中心展示
  created_by          uuid REFERENCES public.profiles(id),
  approved_by         uuid REFERENCES public.profiles(id),
  journal_id          uuid REFERENCES public.journal_entries(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gl_queue_status      ON public.gl_posting_queue (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_gl_queue_source      ON public.gl_posting_queue (source_type, source_id, business_event);
CREATE INDEX IF NOT EXISTS idx_gl_queue_journal     ON public.gl_posting_queue (journal_id);

-- RLS：与系统既有口径一致（USING(true)，可见优先；真正写入鉴权在服务端 API 层）
ALTER TABLE public.gl_posting_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gl_queue_select" ON public.gl_posting_queue;
DROP POLICY IF EXISTS "gl_queue_insert" ON public.gl_posting_queue;
DROP POLICY IF EXISTS "gl_queue_update" ON public.gl_posting_queue;
DROP POLICY IF EXISTS "gl_queue_delete" ON public.gl_posting_queue;
CREATE POLICY "gl_queue_select" ON public.gl_posting_queue FOR SELECT USING (true);
CREATE POLICY "gl_queue_insert" ON public.gl_posting_queue FOR INSERT WITH CHECK (true);
CREATE POLICY "gl_queue_update" ON public.gl_posting_queue FOR UPDATE USING (true);
CREATE POLICY "gl_queue_delete" ON public.gl_posting_queue FOR DELETE USING (true);

-- ── 2. 凭证溯源（provenance）列 ────────────────────────────
-- 没有完整 provenance 的凭证不允许 posted（在 post_journal 内强校验）。
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS business_event       text;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS source_document_id   uuid;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS posting_queue_id     uuid;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS related_order_id     uuid;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS related_customer_id  uuid;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS related_supplier_name text;  -- 本系统供应商为自由文本，无 supplier_id
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS exchange_rate_source text;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS explanation          text;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS requires_review      boolean NOT NULL DEFAULT false;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS approved_by          uuid REFERENCES public.profiles(id);

-- ── 3. RPC：创建 DRAFT 凭证（不写 gl_balances、不 posted） ──
-- 仿 create_journal_atomic，但：status='draft'、posted_by/at 留空、不累加 gl_balances、写 provenance。
-- 会计期间关闭仍然 RAISE（→ 业务侧捕获为 failed，不创建错误凭证）。
CREATE OR REPLACE FUNCTION public.create_journal_draft(
  p_period_code          text,
  p_date                 date,
  p_description          text,
  p_source_type          text,
  p_source_id            uuid,
  p_total_debit          numeric,
  p_total_credit         numeric,
  p_created_by           uuid,
  p_lines                jsonb,
  p_business_event       text,
  p_target_journal_type  text DEFAULT NULL,
  p_posting_queue_id     uuid DEFAULT NULL,
  p_related_order_id     uuid DEFAULT NULL,
  p_related_customer_id  uuid DEFAULT NULL,
  p_related_supplier_name text DEFAULT NULL,
  p_source_document_id   uuid DEFAULT NULL,
  p_exchange_rate_source text DEFAULT NULL,
  p_explanation          text DEFAULT NULL,
  p_requires_review      boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_journal_id uuid;
  v_voucher_no text;
  v_period_status text;
  v_line jsonb;
BEGIN
  -- 借贷平衡预检
  IF abs(p_total_debit - p_total_credit) > 0.001 THEN
    RAISE EXCEPTION 'UNBALANCED: 借方% ≠ 贷方%', p_total_debit, p_total_credit;
  END IF;

  -- 会计期间必须存在且未关闭
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = p_period_code;
  IF v_period_status IS NULL THEN
    RAISE EXCEPTION 'PERIOD_MISSING: 会计期间 % 不存在', p_period_code;
  END IF;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: 会计期间 % 已关闭', p_period_code;
  END IF;

  INSERT INTO public.journal_entries (
    voucher_no, period_code, voucher_date, voucher_type, description,
    source_type, source_id, total_debit, total_credit, status, created_by,
    business_event, source_document_id, posting_queue_id, related_order_id,
    related_customer_id, related_supplier_name, exchange_rate_source, explanation,
    requires_review
  ) VALUES (
    '', p_period_code, p_date, 'auto', p_description,
    p_source_type, p_source_id, p_total_debit, p_total_credit, 'draft', p_created_by,
    p_business_event, p_source_document_id, p_posting_queue_id, p_related_order_id,
    p_related_customer_id, p_related_supplier_name, p_exchange_rate_source, p_explanation,
    p_requires_review
  ) RETURNING id, voucher_no INTO v_journal_id, v_voucher_no;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    INSERT INTO public.journal_lines (
      journal_id, line_no, account_code, description, debit, credit,
      currency, exchange_rate, original_amount, customer_id, supplier_name, order_id
    ) VALUES (
      v_journal_id,
      (v_line->>'line_no')::int,
      v_line->>'account_code',
      coalesce(v_line->>'description',''),
      coalesce((v_line->>'debit')::numeric, 0),
      coalesce((v_line->>'credit')::numeric, 0),
      coalesce(v_line->>'currency','CNY'),
      coalesce((v_line->>'exchange_rate')::numeric, 1),
      nullif(v_line->>'original_amount','')::numeric,
      nullif(v_line->>'customer_id','')::uuid,
      nullif(v_line->>'supplier_name',''),
      nullif(v_line->>'order_id','')::uuid
    );
  END LOOP;

  RETURN jsonb_build_object('journal_id', v_journal_id, 'voucher_no', v_voucher_no);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_journal_draft(
  text, date, text, text, uuid, numeric, numeric, uuid, jsonb, text, text, uuid,
  uuid, uuid, text, uuid, text, text, boolean
) TO authenticated;

-- ── 4. RPC：DRAFT → POSTED（review 通过后才调用） ──────────
-- 强校验 provenance；再次检查期间未关闭；置 posted + approved_by；累加 gl_balances。
CREATE OR REPLACE FUNCTION public.post_journal(
  p_journal_id uuid,
  p_posted_by  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_status text;
  v_period text;
  v_period_status text;
  v_debit numeric;
  v_credit numeric;
  v_src_type text;
  v_src_id uuid;
  v_event text;
  v_created_by uuid;
BEGIN
  SELECT status, period_code, total_debit, total_credit, source_type, source_id, business_event, created_by
    INTO v_status, v_period, v_debit, v_credit, v_src_type, v_src_id, v_event, v_created_by
  FROM public.journal_entries WHERE id = p_journal_id FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: 凭证 % 不存在', p_journal_id;
  END IF;
  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'NOT_DRAFT: 凭证当前状态 % 不可过账（仅 draft 可过账）', v_status;
  END IF;

  -- provenance 完整性：缺失则禁止过账
  IF v_src_type IS NULL OR v_src_id IS NULL OR v_event IS NULL OR v_created_by IS NULL THEN
    RAISE EXCEPTION 'MISSING_PROVENANCE: 凭证溯源不完整，禁止过账';
  END IF;

  -- 借贷平衡（双保险）
  IF abs(v_debit - v_credit) > 0.001 THEN
    RAISE EXCEPTION 'UNBALANCED: 借方% ≠ 贷方%', v_debit, v_credit;
  END IF;

  -- 期间未关闭
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = v_period;
  IF v_period_status = 'closed' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: 会计期间 % 已关闭', v_period;
  END IF;

  UPDATE public.journal_entries
     SET status = 'posted', posted_by = p_posted_by, posted_at = now(),
         approved_by = p_posted_by, requires_review = false
   WHERE id = p_journal_id;

  -- 累加 gl_balances（与 create_journal_atomic 内联逻辑一致）
  INSERT INTO public.gl_balances (account_code, period_code, period_debit, period_credit)
  SELECT account_code, v_period, SUM(debit), SUM(credit)
    FROM public.journal_lines WHERE journal_id = p_journal_id
   GROUP BY account_code
  ON CONFLICT (account_code, period_code) DO UPDATE
    SET period_debit  = public.gl_balances.period_debit  + EXCLUDED.period_debit,
        period_credit = public.gl_balances.period_credit + EXCLUDED.period_credit;

  RETURN jsonb_build_object('journal_id', p_journal_id, 'status', 'posted');
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_journal(uuid, uuid) TO authenticated;

-- 验证：
-- SELECT to_regclass('public.gl_posting_queue');
-- SELECT proname FROM pg_proc WHERE proname IN ('create_journal_draft','post_journal');
-- SELECT column_name FROM information_schema.columns WHERE table_name='journal_entries' AND column_name IN ('business_event','requires_review','approved_by');
