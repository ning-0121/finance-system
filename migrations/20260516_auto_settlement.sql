-- ============================================================
-- 20260516 · Auto-Settlement on Shipping Completion
--
-- 业务规则（与 Wave 1 AI 原则一致）：
--   1. shipping_documents.status → 'completed' 触发
--   2. 仅当该订单无未 voided 的 settlement 时创建
--   3. 创建为 status='draft', auto_generated=true, source_shipping_id=NEW.id
--   4. 永远不直接进 confirmed/locked — 必须人审
--   5. freeze 已由 Wave 1-B 在 settlement INSERT 时拦截，无需重复
--   6. provenance 已由 Wave 1-D AFTER INSERT 触发器自动记录
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. order_settlements 加 auto_generated + source_shipping_id 列
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.order_settlements
  ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_shipping_id uuid REFERENCES public.shipping_documents(id);

-- ─────────────────────────────────────────────────────────────
-- 2. 幂等约束：同一订单只能有一张非 voided/cancelled 且未软删的 settlement
-- ─────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uniq_order_settlements_active_per_order
  ON public.order_settlements (budget_order_id)
  WHERE deleted_at IS NULL AND status NOT IN ('voided', 'cancelled');


-- ─────────────────────────────────────────────────────────────
-- 3. Trigger: shipping_documents status → 'completed' 时尝试建 draft 结算
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_auto_create_settlement_on_shipping_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_existing_count int;
  v_settlement_id uuid;
BEGIN
  -- 只在 status: 任意非 completed → completed 时触发
  IF NEW.status <> 'completed' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN RETURN NEW; END IF;

  -- 幂等：该订单已有未 voided 的 settlement？
  SELECT count(*) INTO v_existing_count
  FROM public.order_settlements
  WHERE budget_order_id = NEW.budget_order_id
    AND deleted_at IS NULL
    AND status NOT IN ('voided', 'cancelled');

  IF v_existing_count > 0 THEN
    -- 已有 settlement，跳过 — 但留 audit 痕迹（avoid silent skip）
    INSERT INTO public.save_diagnostic_logs (
      action, table_name, record_id, source_page, status, error_detail, actor_id
    ) VALUES (
      'auto_create_skip', 'order_settlements', NEW.budget_order_id::text,
      'shipping_trigger', 'ok',
      format('订单已有 %s 张非 voided settlement，跳过自动建单', v_existing_count),
      coalesce(current_setting('audit.actor_id', true), 'system')
    );
    RETURN NEW;
  END IF;

  -- 创建 draft settlement
  -- 注意：Wave 1-B freeze guard 会在 INSERT 时检查 budget_order 是否冻结
  -- 如冻结，本 INSERT 会 RAISE，导致 shipping_documents 也 rollback —
  -- 这是预期行为（冻结订单不允许任何 mutation）
  INSERT INTO public.order_settlements (
    budget_order_id, sub_settlements, order_level_costs,
    total_budget, total_actual, total_variance,
    final_profit, final_margin, status,
    auto_generated, source_shipping_id
  ) VALUES (
    NEW.budget_order_id, '[]'::jsonb, '{}'::jsonb,
    0, 0, 0, 0, 0, 'draft',
    true, NEW.id
  )
  RETURNING id INTO v_settlement_id;

  -- audit：明确标记 system 自动触发
  INSERT INTO public.save_diagnostic_logs (
    action, table_name, record_id, source_page, status, error_detail, actor_id
  ) VALUES (
    'auto_create', 'order_settlements', v_settlement_id::text,
    'shipping_trigger', 'ok',
    format('[AUTO_SETTLEMENT] order=%s shipping=%s settlement=%s',
           NEW.budget_order_id, NEW.id, v_settlement_id),
    coalesce(current_setting('audit.actor_id', true), 'system')
  );

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_settlement_on_ship_complete ON public.shipping_documents;
CREATE TRIGGER trg_auto_settlement_on_ship_complete
  AFTER INSERT OR UPDATE OF status ON public.shipping_documents
  FOR EACH ROW EXECUTE FUNCTION public.trg_auto_create_settlement_on_shipping_complete();


-- ─────────────────────────────────────────────────────────────
-- 4. 防 auto → confirmed/locked 直接跳转：必须人工设 settled_by
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_settlement_confirm_requires_human()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('confirmed','locked') AND OLD.status = 'draft' THEN
    IF NEW.settled_by IS NULL THEN
      RAISE EXCEPTION 'AUTO_SETTLEMENT_REQUIRES_HUMAN: draft → % 必须由人指定 settled_by，自动生成的 settlement 不能自动 confirm', NEW.status;
    END IF;
    IF NEW.auto_generated = true AND OLD.settled_by IS NULL AND NEW.settled_by IS NULL THEN
      RAISE EXCEPTION 'AUTO_SETTLEMENT_REQUIRES_HUMAN: auto_generated settlement 必须有人工 settled_by';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_settlement_confirm_human ON public.order_settlements;
CREATE TRIGGER trg_settlement_confirm_human
  BEFORE UPDATE OF status ON public.order_settlements
  FOR EACH ROW EXECUTE FUNCTION public.trg_settlement_confirm_requires_human();


-- ─────────────────────────────────────────────────────────────
-- 5. 自验证
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_trigger WHERE tgname IN ('trg_auto_settlement_on_ship_complete','trg_settlement_confirm_human');
  IF v < 2 THEN RAISE EXCEPTION 'auto-settlement: 缺 trigger'; END IF;
  SELECT count(*) INTO v FROM pg_indexes WHERE indexname = 'uniq_order_settlements_active_per_order';
  IF v < 1 THEN RAISE EXCEPTION 'auto-settlement: 缺幂等 index'; END IF;
  RAISE NOTICE '✓ auto-settlement 已就绪 (2 triggers + idempotent index + 2 columns)';
END $$;
