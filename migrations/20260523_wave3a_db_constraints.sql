-- ============================================================
-- 20260523 Wave 3-A · DB Constraints Batch
--
-- 修复 4 项：
--   P1-E1  payable_records 加 UNIQUE(settlement_id, invoice_id) WHERE active
--          → 防 settlement 路由 dedupe race 时漏判
--   P1-E2  新建 get_or_create_customer RPC
--          → 防 sync 并发 customer lookup-then-create race
--   P1-E3  synced_orders 加 version 列 + 自增 trigger
--          → 允许应用层做 .eq('version', X) 乐观锁
--   P2-E2  document_actions 加 execution_error 列
--          → 保留 ExecutionResult.error 供回滚追溯
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- P1-E1 · payable_records UNIQUE(settlement_id, invoice_id) 防重复
-- ─────────────────────────────────────────────────────────────
-- 先清理潜在历史重复（保留最早）
DO $$
BEGIN
  WITH dup AS (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY settlement_id, invoice_id
      ORDER BY created_at ASC
    ) AS rn
    FROM public.payable_records
    WHERE settlement_id IS NOT NULL
      AND invoice_id IS NOT NULL
      AND deleted_at IS NULL
  )
  UPDATE public.payable_records
  SET deleted_at = now(),
      delete_reason = '[wave3a] 历史重复应付，按时间保留最早一条'
  WHERE id IN (SELECT id FROM dup WHERE rn > 1);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_payable_settlement_invoice
  ON public.payable_records (settlement_id, invoice_id)
  WHERE deleted_at IS NULL AND invoice_id IS NOT NULL;


-- ─────────────────────────────────────────────────────────────
-- P1-E2 · get_or_create_customer RPC
--   通过 advisory lock 确保 lookup-or-create 串行化
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_or_create_customer(
  p_name      text,
  p_currency  text DEFAULT 'USD'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_customer record;
  v_clean_name text;
  v_lock_key bigint;
BEGIN
  v_clean_name := trim(coalesce(p_name, ''));
  IF v_clean_name = '' THEN
    RAISE EXCEPTION 'CUSTOMER_NAME_EMPTY: 客户名不能为空';
  END IF;

  -- 按名称 hash 取 advisory lock（事务级）— 同一客户名的并发请求会串行
  v_lock_key := hashtext('customer_create:' || v_clean_name);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 现在再查询（其他 holder 已释放）
  SELECT id, name, company INTO v_customer
  FROM public.customers
  WHERE company ILIKE '%' || v_clean_name || '%'
     OR name    ILIKE '%' || v_clean_name || '%'
  ORDER BY
    -- 完全匹配优先
    CASE WHEN company = v_clean_name THEN 0
         WHEN name    = v_clean_name THEN 1
         ELSE 2 END,
    created_at ASC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id', v_customer.id,
      'name', v_customer.name,
      'company', v_customer.company,
      'created', false
    );
  END IF;

  -- 不存在 → 创建
  INSERT INTO public.customers (name, company, currency)
  VALUES (v_clean_name, v_clean_name, coalesce(p_currency, 'USD'))
  RETURNING id, name, company INTO v_customer;

  RETURN jsonb_build_object(
    'id', v_customer.id,
    'name', v_customer.name,
    'company', v_customer.company,
    'created', true
  );
END $$;

COMMENT ON FUNCTION public.get_or_create_customer IS
'Wave 3-A P1-E2: 通过 pg_advisory_xact_lock 串行化同名客户的并发 lookup-or-create，消除 race。';


-- ─────────────────────────────────────────────────────────────
-- P1-E3 · synced_orders 加 version 列 + 自增触发器
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.synced_orders
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.trg_synced_orders_bump_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- 若调用方主动改 version（乐观锁场景）就尊重；否则自动 +1
  IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_synced_orders_version ON public.synced_orders;
CREATE TRIGGER trg_synced_orders_version
  BEFORE UPDATE ON public.synced_orders
  FOR EACH ROW EXECUTE FUNCTION public.trg_synced_orders_bump_version();


-- ─────────────────────────────────────────────────────────────
-- P2-E2 · document_actions 加 execution_error 列
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.document_actions
  ADD COLUMN IF NOT EXISTS execution_error text;


-- ─────────────────────────────────────────────────────────────
-- 自验证
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_indexes WHERE indexname='uniq_payable_settlement_invoice';
  IF v <> 1 THEN RAISE EXCEPTION 'P1-E1 missing unique index'; END IF;

  SELECT count(*) INTO v FROM pg_proc WHERE proname='get_or_create_customer';
  IF v <> 1 THEN RAISE EXCEPTION 'P1-E2 missing RPC'; END IF;

  SELECT count(*) INTO v FROM information_schema.columns
    WHERE table_name='synced_orders' AND column_name='version';
  IF v <> 1 THEN RAISE EXCEPTION 'P1-E3 missing version column'; END IF;

  SELECT count(*) INTO v FROM information_schema.columns
    WHERE table_name='document_actions' AND column_name='execution_error';
  IF v <> 1 THEN RAISE EXCEPTION 'P2-E2 missing execution_error'; END IF;

  RAISE NOTICE '✓ Wave 3-A 4 项已就绪';
END $$;
