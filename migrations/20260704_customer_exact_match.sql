-- ============================================================
-- P0-4：get_or_create_customer 客户匹配从「子串 ILIKE」改「精确匹配」
-- 背景(审计 P0)：原 WHERE company ILIKE '%name%' OR name ILIKE '%name%' 是子串匹配，
--   查 "ABC" 会命中 "ABC Group"、查 "李" 命中所有含"李"的客户 → 订单挂错客户主体 =
--   应收/利润归错，财务级数据污染。改为大小写不敏感的【精确】匹配。
-- 仅改匹配 WHERE，其余(advisory lock 串行化、签名等)不动。加可逆(down 恢复子串)。
-- 注：节拍器订单 payload 目前只带 customer_name 不带 qimo_customer_id，故本次先做精确名匹配；
--    待节拍器补传 qimo_customer_id 后再加等值匹配一层(需另配 payload 与调用点)。
-- ============================================================
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

  v_lock_key := hashtext('customer_create:' || v_clean_name);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- 精确匹配（大小写不敏感）——不再用 '%name%' 子串，杜绝串号
  SELECT id, name, company INTO v_customer
  FROM public.customers
  WHERE lower(company) = lower(v_clean_name)
     OR lower(name)    = lower(v_clean_name)
  ORDER BY
    CASE WHEN company = v_clean_name THEN 0
         WHEN name    = v_clean_name THEN 1
         ELSE 2 END,
    created_at ASC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object('id', v_customer.id, 'name', v_customer.name, 'company', v_customer.company, 'created', false);
  END IF;

  INSERT INTO public.customers (name, company, currency)
  VALUES (v_clean_name, v_clean_name, coalesce(p_currency, 'USD'))
  RETURNING id, name, company INTO v_customer;

  RETURN jsonb_build_object('id', v_customer.id, 'name', v_customer.name, 'company', v_customer.company, 'created', true);
END $$;
