-- ============================================================
-- 20260516 Fix · entity_freezes.entity_id 是 text，SDL.status 用 'ok'
-- ============================================================

-- 1. financial_freeze_guard: 把比较改为 entity_id = p_entity_id::text
CREATE OR REPLACE FUNCTION public.financial_freeze_guard(
  p_entity_type text,
  p_entity_id   uuid
) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_freeze record;
BEGIN
  IF coalesce(current_setting('financial.allow_frozen_write', true), '') = 'on' THEN
    RETURN;
  END IF;

  SELECT entity_name, freeze_reason, freeze_type, frozen_by, frozen_at
  INTO v_freeze
  FROM public.entity_freezes
  WHERE entity_type = p_entity_type
    AND entity_id = p_entity_id::text   -- ★ entity_id 列是 text
    AND status = 'frozen'
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'FROZEN_ENTITY: %/% (name=%) 已冻结，无法写入。原因: % | 类型: % | 冻结于: %',
      p_entity_type, p_entity_id, v_freeze.entity_name,
      v_freeze.freeze_reason, v_freeze.freeze_type, v_freeze.frozen_at
      USING HINT = '请先解冻（unfreeze_requested → 二级审批）或紧急通道 set_config(financial.allow_frozen_write,on,true)';
  END IF;
END $$;

-- 2. _admin_bypass_freeze_write: status 改为 'ok'（满足 SDL CHECK）
CREATE OR REPLACE FUNCTION public._admin_bypass_freeze_write(
  p_sql       text,
  p_reason    text,
  p_actor     uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_rows int;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 8 THEN
    RAISE EXCEPTION '紧急绕过必须填写原因（≥8 字符），将永久审计';
  END IF;
  IF p_actor IS NULL THEN RAISE EXCEPTION '必须提供 actor uuid'; END IF;

  PERFORM set_config('financial.allow_frozen_write', 'on', true);
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.save_diagnostic_logs (
    action, table_name, source_page, status, error_detail, actor_id
  ) VALUES (
    'bypass_freeze', '_admin', 'rpc',
    'ok',  -- ★ SDL CHECK 允许的枚举
    format('[BYPASS_FREEZE] actor=%s reason=%s rows=%s sql=%s',
           p_actor, p_reason, v_rows, substring(p_sql for 200)),
    p_actor::text  -- ★ actor_id 列是 text
  );

  RETURN jsonb_build_object('rows', v_rows, 'reason', p_reason, 'actor', p_actor);
END $$;

REVOKE ALL ON FUNCTION public._admin_bypass_freeze_write FROM PUBLIC, anon, authenticated;

DO $$ BEGIN RAISE NOTICE '✓ Wave 1-B fix: text cast + SDL status'; END $$;
