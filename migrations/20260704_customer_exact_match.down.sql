-- 回滚：恢复 get_or_create_customer 的子串 ILIKE 匹配（不推荐，会串号）
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
  SELECT id, name, company INTO v_customer
  FROM public.customers
  WHERE company ILIKE '%' || v_clean_name || '%'
     OR name    ILIKE '%' || v_clean_name || '%'
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
