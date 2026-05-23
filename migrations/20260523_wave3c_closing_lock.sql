-- ============================================================
-- 20260523 Wave 3-C · 关账并发锁 (P1-E6)
--
-- 问题：runFullClosingChecklist 跑 12 项检查时，并发请求会重跑
--      或 initClosingChecklist (DELETE+INSERT) clobber 在跑的检查
--
-- 方案：CAS pattern — period.status open→closing 时为"获锁"，结束后恢复 open
--      仅当真正完成关账（人工 confirm）才转 closed
-- ============================================================

CREATE OR REPLACE FUNCTION public.begin_period_close(p_period_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_acquired boolean;
  v_current_status text;
BEGIN
  -- CAS: open → closing
  UPDATE public.accounting_periods
  SET status = 'closing'
  WHERE period_code = p_period_code
    AND status = 'open'
  RETURNING true INTO v_acquired;

  IF coalesce(v_acquired, false) THEN
    RETURN jsonb_build_object('acquired', true, 'period_code', p_period_code);
  END IF;

  -- 没获取到 → 看下当前状态做错误说明
  SELECT status INTO v_current_status FROM public.accounting_periods WHERE period_code = p_period_code;
  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'PERIOD_NOT_FOUND: %', p_period_code;
  END IF;
  IF v_current_status = 'closing' THEN
    RAISE EXCEPTION 'PERIOD_CLOSE_IN_PROGRESS: % 已有另一个关账流程在跑', p_period_code;
  END IF;
  IF v_current_status = 'closed' THEN
    RAISE EXCEPTION 'PERIOD_ALREADY_CLOSED: %', p_period_code;
  END IF;
  RAISE EXCEPTION 'PERIOD_INVALID_STATE: % status=%', p_period_code, v_current_status;
END $$;

CREATE OR REPLACE FUNCTION public.end_period_close(p_period_code text, p_final_status text DEFAULT 'open')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE v_updated int;
BEGIN
  IF p_final_status NOT IN ('open', 'closed') THEN
    RAISE EXCEPTION 'INVALID_FINAL_STATUS: % (allowed: open, closed)', p_final_status;
  END IF;

  UPDATE public.accounting_periods
  SET status = p_final_status,
      closed_at = CASE WHEN p_final_status = 'closed' THEN now() ELSE closed_at END
  WHERE period_code = p_period_code
    AND status = 'closing';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object('released', v_updated > 0, 'final_status', p_final_status, 'rows', v_updated);
END $$;

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM pg_proc WHERE proname IN ('begin_period_close','end_period_close');
  IF v <> 2 THEN RAISE EXCEPTION 'Wave 3-C closing lock RPCs 缺失'; END IF;
  RAISE NOTICE '✓ Wave 3-C closing lock 已就绪';
END $$;
