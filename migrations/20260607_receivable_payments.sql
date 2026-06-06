-- ============================================================
-- 回款流水层（应收财务化）：流水明细 → 匹配关系 → projection 汇总
--
-- 原则：累计收款字段(budget_orders.ar_received_amount)仅作 projection/缓存，
--       真实已收 = receivable_payment_allocations 按订单汇总。
--
-- 两张表支持「一笔回款配多单 / 一单多笔回款 / 部分匹配 / 撤销匹配」：
--   receivable_payments            一笔银行/客户回款（总额）
--   receivable_payment_allocations 该回款分配到各订单的金额（多对多）
--
-- 可加可逆；RLS 采用系统统一 USING(true) 口径。
-- 回滚见 20260607_receivable_payments.down.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.receivable_payments (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id        uuid,                          -- 客户主数据 id（可空）
  customer_name      text,                          -- 客户名（冗余，便于自动匹配/展示）
  budget_order_id    uuid,                          -- 便捷单订单匹配（可空；多单匹配以分配表为准）
  amount_original    numeric(15,2) NOT NULL,        -- 回款原币金额
  currency           text NOT NULL DEFAULT 'CNY',
  exchange_rate      numeric(12,4) NOT NULL DEFAULT 1,
  amount_cny         numeric(15,2) NOT NULL,        -- 折人民币金额（权威汇总口径）
  received_at        date,                          -- 到账日期
  bank_account       text,                          -- 收款银行/账户
  payment_reference  text,                          -- 银行流水号/凭证号
  source_type        text NOT NULL DEFAULT 'manual'
                       CHECK (source_type IN ('manual','bank_receipt','wecom_file','ocr')),
  source_document_id uuid,                          -- 关联来源单据（银行回单/企微文件等）
  matched_status     text NOT NULL DEFAULT 'unmatched'
                       CHECK (matched_status IN ('unmatched','partially_matched','matched','disputed')),
  notes              text,
  created_by         uuid REFERENCES public.profiles(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE IF NOT EXISTS public.receivable_payment_allocations (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  receipt_id      uuid NOT NULL REFERENCES public.receivable_payments(id) ON DELETE CASCADE,
  budget_order_id uuid NOT NULL,
  amount_cny      numeric(15,2) NOT NULL,           -- 本次分配到该订单的人民币金额
  amount_original numeric(15,2),                    -- 对应原币（便于展示）
  created_by      uuid REFERENCES public.profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recv_pay_customer ON public.receivable_payments (customer_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recv_pay_status   ON public.receivable_payments (matched_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recv_alloc_order  ON public.receivable_payment_allocations (budget_order_id);
CREATE INDEX IF NOT EXISTS idx_recv_alloc_receipt ON public.receivable_payment_allocations (receipt_id);

ALTER TABLE public.receivable_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_payment_allocations ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['receivable_payments','receivable_payment_allocations'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_select" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_insert" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_update" ON public.%1$s', t);
    EXECUTE format('DROP POLICY IF EXISTS "%1$s_delete" ON public.%1$s', t);
    EXECUTE format('CREATE POLICY "%1$s_select" ON public.%1$s FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY "%1$s_insert" ON public.%1$s FOR INSERT WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY "%1$s_update" ON public.%1$s FOR UPDATE USING (true)', t);
    EXECUTE format('CREATE POLICY "%1$s_delete" ON public.%1$s FOR DELETE USING (true)', t);
  END LOOP;
END $$;

-- 验证：
-- SELECT to_regclass('public.receivable_payments'), to_regclass('public.receivable_payment_allocations');
