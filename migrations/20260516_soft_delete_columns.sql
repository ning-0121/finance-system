-- ============================================================
-- Wave 1-A · Soft Delete Infrastructure
-- 财务实体禁止物理删除；统一通过 softDeleteFinancialEntity() service
-- ============================================================
--
-- 修改点：
--   1. 9 张财务表添加 deleted_at / deleted_by / delete_reason
--   2. partial 索引：WHERE deleted_at IS NULL（保持现存读路径性能）
--   3. BEFORE DELETE 触发器：除非 session var financial.allow_hard_delete='on'
--      否则 RAISE EXCEPTION（不允许静默物理删除）
--   4. 管理员 RPC _admin_hard_delete(table, id, reason)：
--      SECURITY DEFINER + 仅 service_role 可调用 + 设置 session var 后执行
--      仅供测试 cleanup / DBA 紧急修复使用，生产代码禁用
--   5. RLS：保留现有 "for all using (true)" 政策不动（trigger 已经拦截 DELETE）
--   6. backfill 安全：仅 ADD COLUMN（IF NOT EXISTS），不修改任何现有行
--
-- 回滚：见 20260516_soft_delete_columns.down.sql
-- ============================================================

-- ─── 1. 添加列（idempotent）─────────────────────────────────
DO $$
DECLARE
  t text;
  financial_tables text[] := ARRAY[
    'actual_invoices','payable_records','order_settlements','budget_orders',
    'shipping_documents','financial_risk_events','cost_items',
    'journal_entries','journal_lines'
  ];
BEGIN
  FOREACH t IN ARRAY financial_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_at  timestamptz', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS deleted_by  uuid', t);
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS delete_reason text', t);
  END LOOP;
END $$;

-- ─── 2. partial 索引（保持读性能）──────────────────────────
CREATE INDEX IF NOT EXISTS idx_actual_invoices_active        ON public.actual_invoices(id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payable_records_active        ON public.payable_records(id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_order_settlements_active      ON public.order_settlements(id)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_budget_orders_active          ON public.budget_orders(id)          WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shipping_documents_active     ON public.shipping_documents(id)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_financial_risk_events_active  ON public.financial_risk_events(id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cost_items_active             ON public.cost_items(id)             WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_entries_active        ON public.journal_entries(id)        WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_journal_lines_active          ON public.journal_lines(id)          WHERE deleted_at IS NULL;

-- ─── 3. 物理删除拦截触发器 ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.financial_hard_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- session var bypass：仅供 _admin_hard_delete RPC 使用（SECURITY DEFINER 中设置）
  IF coalesce(current_setting('financial.allow_hard_delete', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'HARD_DELETE_FORBIDDEN: 表 % (id=%) 不允许物理删除',
    TG_TABLE_NAME, OLD.id
    USING HINT = '请使用 softDeleteFinancialEntity() service；测试/DBA 通过 _admin_hard_delete RPC';
END $$;

-- 在 9 张表上挂触发器
DO $$
DECLARE
  t text;
  financial_tables text[] := ARRAY[
    'actual_invoices','payable_records','order_settlements','budget_orders',
    'shipping_documents','financial_risk_events','cost_items',
    'journal_entries','journal_lines'
  ];
BEGIN
  FOREACH t IN ARRAY financial_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_no_hard_delete ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_no_hard_delete BEFORE DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.financial_hard_delete_guard()',
      t
    );
  END LOOP;
END $$;

-- ─── 4. 管理员 RPC：受控物理删除（测试 / DBA 紧急修复）─────
CREATE OR REPLACE FUNCTION public._admin_hard_delete(
  p_table text,
  p_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_allowed text[] := ARRAY[
    'actual_invoices','payable_records','order_settlements','budget_orders',
    'shipping_documents','financial_risk_events','cost_items',
    'journal_entries','journal_lines'
  ];
BEGIN
  IF NOT (p_table = ANY(v_allowed)) THEN
    RAISE EXCEPTION '_admin_hard_delete: 表 % 不在受保护清单内（不需要此 RPC）', p_table;
  END IF;

  -- 设置 session var（SECURITY DEFINER 上下文，is_local=true 仅本事务有效）
  PERFORM set_config('financial.allow_hard_delete', 'on', true);

  EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_table) USING p_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'table', p_table,
    'id', p_id,
    'deleted_rows', v_count,
    'reason', p_reason,
    'executed_at', now()
  );
END $$;

REVOKE ALL ON FUNCTION public._admin_hard_delete(text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ─── 5. 验证 DO 块 ────────────────────────────────────────
DO $$
DECLARE
  t text;
  financial_tables text[] := ARRAY[
    'actual_invoices','payable_records','order_settlements','budget_orders',
    'shipping_documents','financial_risk_events','cost_items',
    'journal_entries','journal_lines'
  ];
  v_col_count integer;
  v_trg_count integer;
  v_idx_count integer;
BEGIN
  FOREACH t IN ARRAY financial_tables LOOP
    SELECT COUNT(*) INTO v_col_count
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t
       AND column_name IN ('deleted_at','deleted_by','delete_reason');
    IF v_col_count <> 3 THEN
      RAISE EXCEPTION '表 % 缺失软删除列（expect 3, got %）', t, v_col_count;
    END IF;

    SELECT COUNT(*) INTO v_trg_count
      FROM pg_trigger WHERE tgname = 'trg_no_hard_delete'
        AND tgrelid = format('public.%I', t)::regclass;
    IF v_trg_count <> 1 THEN
      RAISE EXCEPTION '表 % 缺失 trg_no_hard_delete 触发器', t;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO v_idx_count
    FROM pg_indexes WHERE schemaname='public'
      AND indexname LIKE 'idx_%_active';
  IF v_idx_count < 9 THEN
    RAISE EXCEPTION 'partial 索引数量不足（got %, expect ≥9）', v_idx_count;
  END IF;

  -- 验证 _admin_hard_delete 存在
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_admin_hard_delete') THEN
    RAISE EXCEPTION '_admin_hard_delete RPC 未创建';
  END IF;

  RAISE NOTICE '✓ Wave 1-A 验证通过：9 表 × (3 列 + 1 触发器) + ≥9 partial 索引 + _admin_hard_delete RPC';
END $$;
