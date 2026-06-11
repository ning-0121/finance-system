-- ============================================================
-- Phase 2 #1：业务表期间锁（锁账强制力从凭证层扩展到业务层）
--
-- 背景：accounting_periods 锁账后，原触发器只拦 journal_entries；
-- 已关账期间的 费用/回款/匹配/付款/应付/决算 仍可增删改 → 月结数字漂移。
-- 本迁移让 closed 期间的业务数据在数据库层不可变更。
--
-- 判定口径（业务日期，按中国时区归属期间）：
--   cost_items                      送货日期 delivery_date（缺省回退录入时间）
--   receivable_payments             收款日期 received_at（缺省回退录入时间）
--   receivable_payment_allocations  匹配创建时间（撤销已锁期间的匹配同样被拦）
--   supplier_payments               付款日期 paid_at（缺省回退录入时间）
--   payable_records                 实际付款日 paid_at（未付款的单据不受限，可正常审批）
--   order_settlements               决算创建时间（锁账后重生成旧期间决算被拦）
--
-- UPDATE/DELETE 同时校验 旧值+新值 的所属期间：既不能改已锁期间的数据，
-- 也不能把数据的业务日期改入/改出已锁期间。
--
-- 逃生口（仅 admin 维护/历史回填）：同会话执行
--   SET app.allow_closed_period = 'on';
-- 后触发器放行（会话级，不影响其他连接）。
--
-- 可加可逆，回滚见 .down.sql
-- ============================================================

-- 1) 业务日期提取（jsonb 行 → 业务日期，统一中国时区）
CREATE OR REPLACE FUNCTION public._biz_date_of(j jsonb, tbl text) RETURNS date
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  RETURN CASE tbl
    WHEN 'cost_items' THEN
      COALESCE(
        NULLIF(j->>'delivery_date','')::date,
        (NULLIF(j->>'created_at','')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
    WHEN 'receivable_payments' THEN
      COALESCE(
        (NULLIF(j->>'received_at','')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
        (NULLIF(j->>'created_at','')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
    WHEN 'receivable_payment_allocations' THEN
      (NULLIF(j->>'created_at','')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
    WHEN 'supplier_payments' THEN
      COALESCE(
        (NULLIF(j->>'paid_at','')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,
        (NULLIF(j->>'created_at','')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
    WHEN 'payable_records' THEN
      -- 仅实际付款落账后受期间锁约束；未付款的工作流单据不受限
      (NULLIF(j->>'paid_at','')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
    WHEN 'order_settlements' THEN
      (NULLIF(j->>'created_at','')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
    ELSE NULL
  END;
END $$;

-- 2) 期间状态校验
CREATE OR REPLACE FUNCTION public._closed_period_check(d date, tbl text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
DECLARE pcode text; pstatus text;
BEGIN
  IF d IS NULL THEN RETURN; END IF;
  pcode := to_char(d, 'YYYY-MM');
  SELECT status INTO pstatus FROM public.accounting_periods WHERE period_code = pcode;
  IF pstatus = 'closed' THEN
    RAISE EXCEPTION '会计期间 % 已锁账，%（业务日期 %）不允许新增/修改/删除。如确需调整，请到月结中心走解锁审批后再操作', pcode, tbl, d
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- 3) 触发器主体（INSERT 查新值；UPDATE 查旧值+新值；DELETE 查旧值）
CREATE OR REPLACE FUNCTION public.prevent_closed_period_biz_changes()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- 逃生口：admin 维护脚本显式 SET app.allow_closed_period='on' 后放行
  IF current_setting('app.allow_closed_period', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP IN ('UPDATE','DELETE') THEN
    PERFORM public._closed_period_check(public._biz_date_of(to_jsonb(OLD), TG_TABLE_NAME), TG_TABLE_NAME);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM public._closed_period_check(public._biz_date_of(to_jsonb(NEW), TG_TABLE_NAME), TG_TABLE_NAME);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- 4) 挂到 6 张业务表
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'cost_items', 'receivable_payments', 'receivable_payment_allocations',
    'supplier_payments', 'payable_records', 'order_settlements'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE '跳过不存在的表: %', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_closed_period_biz ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_closed_period_biz BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.prevent_closed_period_biz_changes()',
      t);
  END LOOP;
END $$;

-- 验证：
-- ① 触发器就位（应为 6 行）：
-- SELECT event_object_table, trigger_name FROM information_schema.triggers
--  WHERE trigger_name='trg_closed_period_biz' GROUP BY 1,2 ORDER BY 1;
-- ② 功能验证（不影响真实数据，整段执行，预期最后一句报"已锁账"异常后自动回滚）：
-- BEGIN;
--   UPDATE public.accounting_periods SET status='closed' WHERE period_code='2026-01';
--   INSERT INTO public.cost_items (cost_type, description, amount, currency, exchange_rate, delivery_date)
--   VALUES ('other', '__期间锁测试__', 1, 'CNY', 1, '2026-01-15');
-- ROLLBACK;
