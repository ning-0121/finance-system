-- Wave 1-D fix: 用 to_jsonb 避免 plpgsql 编译期字段检查
-- (CASE 表达式所有 branch 都会被 type-check)

CREATE OR REPLACE FUNCTION public.trg_record_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_actor_info jsonb;
  v_action     text;
  v_status_before text;
  v_status_after  text;
  v_row_actor uuid;
  v_session_actor text;
  v_new jsonb;
  v_old jsonb;
BEGIN
  v_session_actor := coalesce(current_setting('audit.actor_id', true), '');
  v_new := to_jsonb(NEW);

  -- 行内 actor: 按表名 → 字段名 jsonb 取值（避免编译期字段检查）
  v_row_actor := COALESCE(
    CASE TG_TABLE_NAME
      WHEN 'journal_entries'   THEN COALESCE(NULLIF(v_new->>'posted_by',''), v_new->>'created_by')
      WHEN 'order_settlements' THEN v_new->>'settled_by'
      WHEN 'cost_items'        THEN COALESCE(NULLIF(v_new->>'deleted_by',''), v_new->>'created_by')
      WHEN 'payable_records'   THEN COALESCE(NULLIF(v_new->>'deleted_by',''), NULLIF(v_new->>'paid_by',''), v_new->>'approved_by')
      WHEN 'actual_invoices'   THEN v_new->>'deleted_by'
      ELSE NULL
    END,
    NULL
  )::uuid;

  v_actor_info := public._fin_prov_resolve_actor(v_session_actor, v_row_actor);

  IF TG_OP = 'INSERT' THEN
    v_action := 'create';
    v_status_after := v_new->>'status';
    v_status_before := NULL;

  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    -- 软删检测
    IF (v_old->>'deleted_at') IS NULL AND (v_new->>'deleted_at') IS NOT NULL THEN
      v_action := 'soft_delete';
    ELSIF (v_old->>'deleted_at') IS NOT NULL AND (v_new->>'deleted_at') IS NULL THEN
      v_action := 'restore';
    -- journal 反向
    ELSIF TG_TABLE_NAME = 'journal_entries' AND (v_old->>'status') = 'posted' AND (v_new->>'status') = 'voided' THEN
      v_action := 'reverse';
    -- 普通状态变更
    ELSIF (v_old->>'status') IS DISTINCT FROM (v_new->>'status') THEN
      v_action := 'status_change';
    ELSE
      RETURN NEW;  -- 不记非状态字段更新（噪音）
    END IF;
    v_status_before := v_old->>'status';
    v_status_after  := v_new->>'status';
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

DO $$ BEGIN RAISE NOTICE '✓ Wave 1-D fix: to_jsonb 动态字段取值'; END $$;
