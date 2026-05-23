-- ============================================================
-- 20260516 Wave 1-D · Financial Provenance Overlay
--
-- 目标：让系统能完整回答 CFO 7 个问题：
--   1. 谁写的？      → actor_id + actor_role
--   2. 为什么写？    → action_type + business_reason
--   3. 来源是什么？  → source_entity_type + source_entity_id
--   4. 依据是什么？  → source_document_id
--   5. 谁批准？      → approval_id + approver_id + approved_at
--   6. 能否回滚？    → reverses_provenance_id ↔ rolled_back_by_provenance_id
--   7. 影响哪些报表？→ affected_reports text[]
--
-- 设计原则：
--   · 纯 overlay，不动现有表结构
--   · 触发器 AFTER INSERT/UPDATE 5 张核心表
--   · INSERT 写一行 ACTION_TYPE='create'
--   · status 变更写 'status_change'
--   · 软删写 'soft_delete'
--   · journal voided 写 'reverse'（并 link 原 provenance）
--   · actor 来自 session var audit.actor_id，缺失则 'system'
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. provenance 主表
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.financial_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO: actor 链
  actor_id    text NOT NULL,
  actor_role  text NOT NULL DEFAULT 'system'
              CHECK (actor_role IN ('system','user','agent','webhook','migration','admin_bypass')),

  -- WHAT: 目标实体 + 状态过渡
  target_table         text NOT NULL,
  target_id            uuid NOT NULL,
  target_status_before text,
  target_status_after  text,

  -- WHY: 业务意图
  action_type     text NOT NULL
                  CHECK (action_type IN (
                    'create','update','status_change','soft_delete','restore',
                    'reverse','rollback','bypass_freeze','auto_generated'
                  )),
  business_reason text,

  -- SOURCE: 这次写入的上游
  source_entity_type text,    -- 'shipping_document'/'invoice'/'manual'/'agent'/'webhook'/'system'/'closing_engine' 等
  source_entity_id   uuid,
  source_document_id uuid,    -- uploaded_documents.id

  -- APPROVAL: 审批链
  approval_id   uuid,
  approver_id   text,
  approved_at   timestamptz,

  -- LINKAGE: 反向关联
  reverses_provenance_id        uuid REFERENCES public.financial_provenance(id),
  rolled_back_by_provenance_id  uuid REFERENCES public.financial_provenance(id),

  -- IMPACT: 影响报表
  affected_reports text[] NOT NULL DEFAULT '{}',

  -- TRACE
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_prov_target          ON public.financial_provenance (target_table, target_id);
CREATE INDEX IF NOT EXISTS idx_fin_prov_actor           ON public.financial_provenance (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_prov_action          ON public.financial_provenance (action_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fin_prov_source          ON public.financial_provenance (source_entity_type, source_entity_id);
CREATE INDEX IF NOT EXISTS idx_fin_prov_approval        ON public.financial_provenance (approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_prov_rolled_back     ON public.financial_provenance (rolled_back_by_provenance_id) WHERE rolled_back_by_provenance_id IS NOT NULL;

COMMENT ON TABLE public.financial_provenance IS
'Wave 1-D: 财务级 7 问审计 overlay。每条记录回答 who/why/source/approval/rollback/reports。';


-- ─────────────────────────────────────────────────────────────
-- 2. helper: 解析当前 actor（先 session var，再 NEW.created_by/settled_by/posted_by/...）
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fin_prov_resolve_actor(
  p_session_var_actor text,
  p_row_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_actor_id text;
  v_role     text := 'system';
BEGIN
  -- 优先级 1: session var（应用层 SET LOCAL audit.actor_id）
  IF p_session_var_actor IS NOT NULL AND p_session_var_actor <> '' THEN
    v_actor_id := p_session_var_actor;
    v_role := 'user';
  -- 优先级 2: 行内的 actor 字段（created_by/settled_by/posted_by）
  ELSIF p_row_actor IS NOT NULL THEN
    v_actor_id := p_row_actor::text;
    v_role := 'user';
  -- 优先级 3: 紧急通道
  ELSIF coalesce(current_setting('financial.allow_frozen_write', true), '') = 'on' THEN
    v_actor_id := coalesce(current_setting('financial.bypass_actor', true), '_admin_bypass');
    v_role := 'admin_bypass';
  -- 兜底
  ELSE
    v_actor_id := 'system';
    v_role := 'system';
  END IF;

  RETURN jsonb_build_object('actor_id', v_actor_id, 'role', v_role);
END $$;


-- ─────────────────────────────────────────────────────────────
-- 3. helper: 表 → affected_reports
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._fin_prov_affected_reports(p_table text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_table
    WHEN 'journal_entries'  THEN ARRAY['trial_balance','profit_loss','general_ledger']
    WHEN 'journal_lines'    THEN ARRAY['trial_balance','profit_loss','general_ledger']
    WHEN 'payable_records'  THEN ARRAY['ap_aging','cashflow']
    WHEN 'actual_invoices'  THEN ARRAY['ap_aging']
    WHEN 'order_settlements'THEN ARRAY['profit_loss','order_profit']
    WHEN 'cost_items'       THEN ARRAY['profit_loss','order_profit']
    WHEN 'budget_orders'    THEN ARRAY['order_profit','ar_aging']
    WHEN 'shipping_documents' THEN ARRAY['order_profit']
    WHEN 'financial_risk_events' THEN ARRAY['control_center']
    ELSE ARRAY[]::text[]
  END
$$;


-- ─────────────────────────────────────────────────────────────
-- 4. 通用 trigger 函数
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_record_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_actor_info jsonb;
  v_action     text;
  v_status_before text;
  v_status_after  text;
  v_row_actor uuid;
  v_session_actor text;
BEGIN
  v_session_actor := coalesce(current_setting('audit.actor_id', true), '');

  -- 选 row 内 actor 字段（按表）
  v_row_actor := CASE TG_TABLE_NAME
    WHEN 'journal_entries'   THEN COALESCE(NEW.posted_by,  NEW.created_by)
    WHEN 'order_settlements' THEN NEW.settled_by
    WHEN 'cost_items'        THEN COALESCE(NEW.deleted_by, NEW.created_by)
    WHEN 'payable_records'   THEN COALESCE(NEW.deleted_by, NEW.paid_by, NEW.approved_by)
    WHEN 'actual_invoices'   THEN NEW.deleted_by
    ELSE NULL
  END;

  v_actor_info := public._fin_prov_resolve_actor(v_session_actor, v_row_actor);

  -- 决定 action_type + status before/after
  IF TG_OP = 'INSERT' THEN
    v_action := 'create';
    v_status_after := NEW.status;
    v_status_before := NULL;

  ELSIF TG_OP = 'UPDATE' THEN
    -- 软删检测（财务表都有 deleted_at 列）
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      v_action := 'soft_delete';
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      v_action := 'restore';
    -- journal 反向（posted → voided）
    ELSIF TG_TABLE_NAME = 'journal_entries' AND OLD.status = 'posted' AND NEW.status = 'voided' THEN
      v_action := 'reverse';
    -- 普通状态变更
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      v_action := 'status_change';
    ELSE
      -- 字段更新但 status/deleted_at 都不变 → 不记 provenance（噪音太大）
      RETURN NEW;
    END IF;
    v_status_before := OLD.status;
    v_status_after := NEW.status;
  END IF;

  INSERT INTO public.financial_provenance (
    actor_id, actor_role,
    target_table, target_id, target_status_before, target_status_after,
    action_type, affected_reports
  ) VALUES (
    v_actor_info->>'actor_id', v_actor_info->>'role',
    TG_TABLE_NAME, NEW.id, v_status_before, v_status_after,
    v_action, public._fin_prov_affected_reports(TG_TABLE_NAME)
  );

  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 5. 挂接到 5 张核心表 (AFTER INSERT/UPDATE)
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['journal_entries','payable_records','actual_invoices','order_settlements','cost_items'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_record_provenance_%I ON public.%I', t, t);
    EXECUTE format('
      CREATE TRIGGER trg_record_provenance_%I
      AFTER INSERT OR UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.trg_record_provenance()
    ', t, t);
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 6. RLS（默认所有人可读自己 actor_id 的记录；admin 可读全部）
--    Wave 1 阶段保持宽松 — 仅启用 RLS 不加策略，等 Wave 2 收紧
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.financial_provenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fp_read_all" ON public.financial_provenance;
DROP POLICY IF EXISTS "fp_write_via_trigger" ON public.financial_provenance;
CREATE POLICY "fp_read_all"          ON public.financial_provenance FOR SELECT USING (true);
CREATE POLICY "fp_write_via_trigger" ON public.financial_provenance FOR INSERT WITH CHECK (true);
-- 禁止 UPDATE / DELETE 由 PostgREST 端（无 policy 即拒绝）；service_role 仍可绕过


-- ─────────────────────────────────────────────────────────────
-- 7. 自验证
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_trigger WHERE tgname LIKE 'trg_record_provenance_%';
  IF v < 5 THEN RAISE EXCEPTION 'Wave 1-D: 缺 provenance trigger (count=%)', v; END IF;
  SELECT count(*) INTO v FROM pg_proc WHERE proname IN ('trg_record_provenance','_fin_prov_resolve_actor','_fin_prov_affected_reports');
  IF v < 3 THEN RAISE EXCEPTION 'Wave 1-D: 缺 provenance 函数 (count=%)', v; END IF;
  RAISE NOTICE '✓ Wave 1-D financial_provenance overlay 已就绪 (table + 3 funcs + 5 triggers)';
END $$;
