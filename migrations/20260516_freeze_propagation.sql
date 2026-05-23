-- ============================================================
-- 20260516 Wave 1-B · Freeze Propagation Engine
-- 修复 P0：entity_freezes 仅 UI 装饰 → mutation 层完全无感
--
-- 设计：
-- 1. financial_freeze_guard(entity_type, entity_id)  ← 单点 RAISE
-- 2. resolver 自动向上传递：子表 trigger 查自己 + 父 budget_order
-- 3. create_journal_atomic RPC 顶部注入 guard
-- 4. session-var bypass：financial.allow_frozen_write='on' （仅 SECURITY DEFINER RPC + DBA 可设置）
-- 5. 解冻审批硬约束：unfrozen_by != frozen_by （触发器拒绝）
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. financial_freeze_guard：原子查询并 RAISE
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.financial_freeze_guard(
  p_entity_type text,
  p_entity_id   uuid
) RETURNS void
LANGUAGE plpgsql
STABLE  -- 同事务内可缓存（仅读）
AS $$
DECLARE
  v_freeze record;
BEGIN
  -- session-var 绕过（DBA/migration 紧急通道，必须留 audit）
  IF coalesce(current_setting('financial.allow_frozen_write', true), '') = 'on' THEN
    RETURN;
  END IF;

  SELECT entity_name, freeze_reason, freeze_type, frozen_by, frozen_at
  INTO v_freeze
  FROM public.entity_freezes
  WHERE entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND status = 'frozen'
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'FROZEN_ENTITY: %/% (name=%) 已冻结，无法写入。原因: % | 类型: % | 冻结于: %',
      p_entity_type, p_entity_id, v_freeze.entity_name,
      v_freeze.freeze_reason, v_freeze.freeze_type, v_freeze.frozen_at
      USING HINT = '请先解冻（unfreeze_requested → 二级审批）或紧急通道 set_config(financial.allow_frozen_write,on,true)';
  END IF;
END $$;

COMMENT ON FUNCTION public.financial_freeze_guard IS
'Wave 1-B: mutation 层强制冻结检查。任何 RPC/trigger 在写入前必须先调用本函数。';


-- ─────────────────────────────────────────────────────────────
-- 2. financial_freeze_guard_with_parent：自动向上传递
--    检查自身 + 立即父级 budget_order（如有）
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.financial_freeze_guard_with_parent(
  p_entity_type   text,
  p_entity_id     uuid,
  p_parent_order_id uuid
) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  -- 1. 自身冻结？
  PERFORM public.financial_freeze_guard(p_entity_type, p_entity_id);
  -- 2. 父 budget_order 冻结？
  IF p_parent_order_id IS NOT NULL THEN
    PERFORM public.financial_freeze_guard('budget_order', p_parent_order_id);
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 3. 通用 trigger 函数：BEFORE INSERT/UPDATE 触发，由各表绑定
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_check_freeze_on_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_self_type text;
  v_parent_order uuid;
BEGIN
  -- 表名映射 → entity_type
  CASE TG_TABLE_NAME
    WHEN 'payable_records'      THEN v_self_type := 'payable_record';
    WHEN 'order_settlements'    THEN v_self_type := 'order_settlement';
    WHEN 'cost_items'           THEN v_self_type := 'cost_item';
    WHEN 'actual_invoices'      THEN v_self_type := 'actual_invoice';
    WHEN 'shipping_documents'   THEN v_self_type := 'shipping_document';
    ELSE v_self_type := TG_TABLE_NAME;
  END CASE;

  -- 父级 order_id 从行里读
  v_parent_order := COALESCE(NEW.budget_order_id, NULL);

  -- 自身 + 父都检查（INSERT 时 NEW.id 可能未生成，跳过自身检查只查父）
  IF TG_OP = 'INSERT' THEN
    IF v_parent_order IS NOT NULL THEN
      PERFORM public.financial_freeze_guard('budget_order', v_parent_order);
    END IF;
  ELSE  -- UPDATE
    PERFORM public.financial_freeze_guard_with_parent(v_self_type, NEW.id, v_parent_order);
  END IF;

  RETURN NEW;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 4. 挂接到 5 张关键财务表
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['payable_records','order_settlements','cost_items','actual_invoices','shipping_documents'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_freeze_guard_%I ON public.%I', t, t);
    EXECUTE format('
      CREATE TRIGGER trg_freeze_guard_%I
      BEFORE INSERT OR UPDATE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.trg_check_freeze_on_mutation()
    ', t, t);
  END LOOP;
END $$;


-- ─────────────────────────────────────────────────────────────
-- 5. 改造 create_journal_atomic — 顶部插入 freeze 检查
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_journal_atomic(
  p_period_code    text,
  p_date           date,
  p_description    text,
  p_source_type    text,
  p_source_id      uuid,
  p_total_debit    numeric,
  p_total_credit   numeric,
  p_voucher_type   text,
  p_created_by     uuid,
  p_lines          jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_journal_id   uuid;
  v_voucher_no   text;
  v_line         jsonb;
  v_line_no      integer := 1;
  v_period_status text;
  v_order_id     uuid;
  v_distinct_orders uuid[];
BEGIN
  -- 1. 期间检查
  SELECT status INTO v_period_status FROM public.accounting_periods WHERE period_code = p_period_code;
  IF v_period_status IS NULL THEN RAISE EXCEPTION '会计期间 % 不存在，请先创建该期间', p_period_code; END IF;
  IF v_period_status = 'closed' THEN RAISE EXCEPTION '会计期间 % 已关闭，不能写入凭证', p_period_code; END IF;

  -- 2. 借贷平衡校验
  IF ABS(p_total_debit - p_total_credit) > 0.001 THEN
    RAISE EXCEPTION '凭证借贷不平衡: 借方 % ≠ 贷方 %', p_total_debit, p_total_credit;
  END IF;

  -- ★ Wave 1-B: 冻结检查 — 检查所有 line 中 distinct 的 order_id
  SELECT array_agg(DISTINCT (line->>'order_id')::uuid)
  INTO v_distinct_orders
  FROM jsonb_array_elements(p_lines) AS line
  WHERE line->>'order_id' IS NOT NULL;

  IF v_distinct_orders IS NOT NULL THEN
    FOREACH v_order_id IN ARRAY v_distinct_orders LOOP
      PERFORM public.financial_freeze_guard('budget_order', v_order_id);
    END LOOP;
  END IF;
  -- 同时检查 source 实体本身（若 source_type 是已知类型）
  IF p_source_type IN ('budget_order', 'budget_orders') THEN
    PERFORM public.financial_freeze_guard('budget_order', p_source_id);
  ELSIF p_source_type IN ('actual_invoice') THEN
    PERFORM public.financial_freeze_guard('actual_invoice', p_source_id);
  ELSIF p_source_type IN ('payable_record', 'payment') THEN
    PERFORM public.financial_freeze_guard('payable_record', p_source_id);
  END IF;
  -- 注意：receipt / settlement 等还未建表的 source_type 暂不强制（避免误伤）

  -- 3. 插入凭证头
  INSERT INTO public.journal_entries (
    voucher_no, period_code, voucher_date, voucher_type, description,
    source_type, source_id, total_debit, total_credit, status,
    created_by, posted_by, posted_at
  ) VALUES (
    '', p_period_code, p_date, p_voucher_type, p_description,
    p_source_type, p_source_id, p_total_debit, p_total_credit, 'posted',
    p_created_by, p_created_by, now()
  )
  RETURNING id, voucher_no INTO v_journal_id, v_voucher_no;

  -- 4. 插入凭证明细行
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO public.journal_lines (
      journal_id, line_no, account_code, description,
      debit, credit, currency, exchange_rate, original_amount,
      customer_id, supplier_name, order_id
    ) VALUES (
      v_journal_id, v_line_no, v_line->>'account_code', v_line->>'description',
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      COALESCE(v_line->>'currency', 'CNY'),
      COALESCE((v_line->>'exchange_rate')::numeric, 1),
      (v_line->>'original_amount')::numeric,
      (v_line->>'customer_id')::uuid,
      v_line->>'supplier_name',
      (v_line->>'order_id')::uuid
    );
    v_line_no := v_line_no + 1;
  END LOOP;

  -- 5. 更新 gl_balances（事务内同步）
  INSERT INTO public.gl_balances (account_code, period_code, period_debit, period_credit)
  SELECT jl.account_code, p_period_code, SUM(jl.debit), SUM(jl.credit)
  FROM public.journal_lines jl
  WHERE jl.journal_id = v_journal_id
  GROUP BY jl.account_code
  ON CONFLICT (account_code, period_code) DO UPDATE SET
    period_debit  = public.gl_balances.period_debit  + EXCLUDED.period_debit,
    period_credit = public.gl_balances.period_credit + EXCLUDED.period_credit,
    updated_at    = now();

  RETURN jsonb_build_object('journal_id', v_journal_id, 'voucher_no', v_voucher_no);
END $$;


-- ─────────────────────────────────────────────────────────────
-- 6. 解冻审批硬约束：unfrozen_by != frozen_by
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_check_unfreeze_segregation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'unfrozen' AND OLD.status = 'frozen' THEN
    IF NEW.unfrozen_by IS NULL THEN
      RAISE EXCEPTION '解冻必须指定 unfrozen_by（不能匿名解冻）';
    END IF;
    IF NEW.unfrozen_by = NEW.frozen_by THEN
      RAISE EXCEPTION '解冻必须由 frozen_by 之外的人执行（职责分离 segregation of duties）';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_unfreeze_segregation ON public.entity_freezes;
CREATE TRIGGER trg_unfreeze_segregation
  BEFORE UPDATE ON public.entity_freezes
  FOR EACH ROW EXECUTE FUNCTION public.trg_check_unfreeze_segregation();


-- ─────────────────────────────────────────────────────────────
-- 7. 紧急通道：_admin_bypass_freeze RPC（仅 service_role 可调）
--    场景：DBA 数据修复 / 紧急回滚 — 必须留 audit
-- ─────────────────────────────────────────────────────────────
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

  -- 事务内 set_config + 执行 + audit
  PERFORM set_config('financial.allow_frozen_write', 'on', true);
  EXECUTE p_sql;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.save_diagnostic_logs (
    action, table_name, source_page, status, error_detail, actor_id
  ) VALUES (
    'bypass_freeze', '_admin', 'rpc', 'success',
    format('[BYPASS_FREEZE] actor=%s reason=%s rows=%s sql=%s',
           p_actor, p_reason, v_rows, substring(p_sql for 200)),
    p_actor
  );

  RETURN jsonb_build_object('rows', v_rows, 'reason', p_reason, 'actor', p_actor);
END $$;

REVOKE ALL ON FUNCTION public._admin_bypass_freeze_write FROM PUBLIC, anon, authenticated;


-- ─────────────────────────────────────────────────────────────
-- 8. 自验证
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname IN ('financial_freeze_guard', 'financial_freeze_guard_with_parent',
                      'trg_check_freeze_on_mutation', 'trg_check_unfreeze_segregation',
                      '_admin_bypass_freeze_write', 'create_journal_atomic');
  IF v_count < 6 THEN RAISE EXCEPTION 'Wave 1-B: 缺函数 (count=%)', v_count; END IF;

  SELECT count(*) INTO v_count FROM pg_trigger
    WHERE tgname IN ('trg_freeze_guard_payable_records', 'trg_freeze_guard_order_settlements',
                     'trg_freeze_guard_cost_items', 'trg_freeze_guard_actual_invoices',
                     'trg_freeze_guard_shipping_documents', 'trg_unfreeze_segregation');
  IF v_count < 6 THEN RAISE EXCEPTION 'Wave 1-B: 缺 trigger (count=%)', v_count; END IF;

  RAISE NOTICE '✓ Wave 1-B freeze propagation 已就绪 (6 functions + 6 triggers)';
END $$;
