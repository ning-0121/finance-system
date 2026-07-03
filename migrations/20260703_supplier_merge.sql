-- ============================================================
-- 供应商归并（主数据治理）
--  1) supplier_aliases 别名映射表：旧名 → 标准名（未来入口自动归一）
--  2) merge_supplier_names RPC：单事务把 5 张表的历史数据改到标准名，
--     供应商档案合并（标准档案缺的银行信息从别名档案补齐，别名档案软删），
--     并登记别名映射 + 审计时间线。财务角色可执行。
-- 可加可逆（回滚见 .down.sql；数据改名不可自动回退，审计里有逐名计数）。
-- ============================================================

-- 1) 别名映射表
CREATE TABLE IF NOT EXISTS public.supplier_aliases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias          text NOT NULL UNIQUE,      -- 旧名（原样存储，匹配时 trim）
  canonical_name text NOT NULL,             -- 标准名
  created_by     uuid REFERENCES public.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_aliases_canonical ON public.supplier_aliases(canonical_name);

ALTER TABLE public.supplier_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sa_read  ON public.supplier_aliases;
DROP POLICY IF EXISTS sa_write ON public.supplier_aliases;
CREATE POLICY sa_read ON public.supplier_aliases FOR SELECT TO authenticated USING (true);
CREATE POLICY sa_write ON public.supplier_aliases FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));

-- 2) 归并 RPC（单事务）
CREATE OR REPLACE FUNCTION public.merge_supplier_names(
  p_aliases   text[],          -- 要归并掉的旧名（不含标准名）
  p_canonical text,            -- 标准名
  p_actor     uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_alias text;
  v_canonical text := btrim(p_canonical);
  n_cost int := 0; n_pay int := 0; n_payable int := 0; n_inv int := 0; n_po int := 0;
  c int;
  v_detail jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND coalesce(public._app_role(),'none') NOT IN ('finance_staff','finance_manager','admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: 供应商归并需财务权限'; END IF;
  IF v_canonical = '' THEN RAISE EXCEPTION 'INVALID_CANONICAL: 标准名不能为空'; END IF;
  IF p_aliases IS NULL OR array_length(p_aliases,1) IS NULL THEN
    RAISE EXCEPTION 'INVALID_ALIASES: 至少选择一个要归并的旧名'; END IF;

  FOREACH v_alias IN ARRAY p_aliases LOOP
    v_alias := btrim(v_alias);
    IF v_alias = '' OR v_alias = v_canonical THEN CONTINUE; END IF;

    -- 五张表历史数据统一改名（含软删行，保证口径彻底一致）
    UPDATE public.cost_items        SET supplier      = v_canonical WHERE btrim(coalesce(supplier,''))      = v_alias;
    GET DIAGNOSTICS c = ROW_COUNT; n_cost := n_cost + c;
    UPDATE public.supplier_payments SET supplier_name = v_canonical WHERE btrim(coalesce(supplier_name,'')) = v_alias;
    GET DIAGNOSTICS c = ROW_COUNT; n_pay := n_pay + c;
    UPDATE public.payable_records   SET supplier_name = v_canonical WHERE btrim(coalesce(supplier_name,'')) = v_alias;
    GET DIAGNOSTICS c = ROW_COUNT; n_payable := n_payable + c;
    UPDATE public.actual_invoices   SET supplier_name = v_canonical WHERE btrim(coalesce(supplier_name,'')) = v_alias;
    GET DIAGNOSTICS c = ROW_COUNT; n_inv := n_inv + c;
    -- 采购单登记簿（表已建；若未来回滚删表，此段需同步调整）
    UPDATE public.fin_purchase_orders SET supplier_name = v_canonical WHERE btrim(coalesce(supplier_name,'')) = v_alias;
    GET DIAGNOSTICS c = ROW_COUNT; n_po := n_po + c;

    -- 供应商档案合并：标准档案缺的银行信息从别名档案补齐，别名档案软删
    UPDATE public.suppliers s SET
      account_no   = COALESCE(NULLIF(s.account_no,''),   a.account_no),
      account_name = COALESCE(NULLIF(s.account_name,''), a.account_name),
      bank_name    = COALESCE(NULLIF(s.bank_name,''),    a.bank_name),
      contact      = COALESCE(NULLIF(s.contact,''),      a.contact),
      phone        = COALESCE(NULLIF(s.phone,''),        a.phone),
      updated_at   = now()
    FROM public.suppliers a
    WHERE btrim(s.name) = v_canonical AND s.deleted_at IS NULL
      AND btrim(a.name) = v_alias AND a.deleted_at IS NULL;
    UPDATE public.suppliers SET deleted_at = now(), notes = COALESCE(notes,'') || ' [已归并→' || v_canonical || ']'
      WHERE btrim(name) = v_alias AND deleted_at IS NULL;

    -- 登记别名映射（幂等）；已有映射链一并压平到新标准名
    INSERT INTO public.supplier_aliases (alias, canonical_name, created_by)
      VALUES (v_alias, v_canonical, p_actor)
      ON CONFLICT (alias) DO UPDATE SET canonical_name = EXCLUDED.canonical_name;
    UPDATE public.supplier_aliases SET canonical_name = v_canonical WHERE canonical_name = v_alias;

    v_detail := v_detail || jsonb_build_object('alias', v_alias);
  END LOOP;

  -- 若标准名在 suppliers 无档案（都是别名档案），创建之
  IF NOT EXISTS (SELECT 1 FROM public.suppliers WHERE btrim(name) = v_canonical AND deleted_at IS NULL) THEN
    INSERT INTO public.suppliers (name, created_by) VALUES (v_canonical, p_actor);
  END IF;

  -- 审计时间线（尽力而为）
  BEGIN
    INSERT INTO public.entity_timeline (entity_type, entity_id, event_type, event_title, event_detail, source_type, actor_id)
    VALUES ('supplier', gen_random_uuid(), 'supplier_merged', '供应商归并',
      jsonb_build_object('canonical', v_canonical, 'aliases', p_aliases,
        'rows', jsonb_build_object('cost_items', n_cost, 'supplier_payments', n_pay,
          'payable_records', n_payable, 'actual_invoices', n_inv, 'fin_purchase_orders', n_po)),
      'user', p_actor);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object('canonical', v_canonical,
    'cost_items', n_cost, 'supplier_payments', n_pay, 'payable_records', n_payable,
    'actual_invoices', n_inv, 'fin_purchase_orders', n_po);
END $$;

GRANT EXECUTE ON FUNCTION public.merge_supplier_names(text[], text, uuid) TO authenticated;

-- 验证：
-- SELECT proname FROM pg_proc WHERE proname='merge_supplier_names';
-- SELECT count(*) FROM public.supplier_aliases;
