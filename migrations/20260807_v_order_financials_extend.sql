-- ============================================================
-- 扩展 v_order_financials:补齐其余页面所需的原始列(2026-08-07)
--
-- 为让订单/应收/审批/工作台等页面也能从视图取数,补入这些标量小列:
--   delivery_date / notes / qimo_order_id / created_at / approved_at /
--   ar_received_amount|at|bank / estimated_profit|margin / 旧标量成本列 lg_*
-- 全是标量,无大 JSONB,体积可控。
--
-- ⚠️ 用 DROP + CREATE 而非 CREATE OR REPLACE:后者不允许改变已有列的顺序
--    (实测报 42P16 cannot change name of view column)。同批次执行,原子生效。
-- ⚠️ 重建后必须重新设置 security_invoker 与 REVOKE —— 这些属性【不会】随
--    DROP/CREATE 保留,漏掉就会重现 2026-08-06 的匿名可读全量财务数据问题。
--
-- 只读视图,不改数据。回滚见 .down.sql。⚠️ 财务库执行。
-- ============================================================
DROP VIEW IF EXISTS public.v_order_financials;
CREATE VIEW public.v_order_financials AS
WITH base AS (
  SELECT b.id, b.order_no, b.order_date, b.delivery_date, b.status, b.currency, b.exchange_rate,
    b.total_revenue, b.total_cost, b.customer_id, b.qimo_order_id, b.notes,
    b.estimated_profit, b.estimated_margin, b.created_at, b.approved_at,
    b.ar_received_amount, b.ar_received_at, b.ar_received_bank,
    c.company AS customer_company, c.country AS customer_country,
    b.items -> 0 -> '_cost_breakdown' AS cb,
    COALESCE(b.target_purchase_price,0) AS lg_purchase, COALESCE(b.estimated_commission,0) AS lg_processing,
    COALESCE(b.estimated_freight,0) AS lg_forwarder, COALESCE(b.estimated_customs_fee,0) AS lg_container,
    COALESCE(b.other_costs,0) AS lg_logistics
  FROM public.budget_orders b LEFT JOIN public.customers c ON c.id=b.customer_id
  WHERE b.deleted_at IS NULL
),
qty AS (SELECT budget_order_id, SUM(COALESCE(quantity,0))::numeric AS quantity
        FROM public.synced_orders WHERE budget_order_id IS NOT NULL GROUP BY budget_order_id),
actual AS (SELECT budget_order_id,
        SUM(COALESCE(amount,0)*CASE WHEN upper(COALESCE(currency,'CNY')) IN ('CNY','RMB') THEN 1
            WHEN COALESCE(exchange_rate,0)>0 THEN exchange_rate ELSE 0 END)::numeric AS actual_cost_cny,
        COUNT(*)::int AS actual_lines
        FROM public.cost_items WHERE deleted_at IS NULL AND cost_type<>'tax_point' GROUP BY budget_order_id),
calc AS (
  SELECT base.*, COALESCE(qty.quantity,0) AS quantity,
    COALESCE(actual.actual_cost_cny,0) AS actual_cost_cny, COALESCE(actual.actual_lines,0) AS actual_lines,
    (base.cb IS NOT NULL) AS has_breakdown,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb->>'finished_goods')::numeric,0) ELSE 0 END AS b_finished_goods,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb->>'fabric')::numeric,0) ELSE base.lg_purchase END AS b_fabric,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb->>'accessory')::numeric,0) ELSE 0 END AS b_accessory,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb->>'processing')::numeric,0) ELSE base.lg_processing END AS b_processing,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb->>'forwarder')::numeric,0) ELSE base.lg_forwarder END AS b_forwarder,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb->>'container')::numeric,0) ELSE base.lg_container END AS b_container,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb->>'logistics')::numeric,0) ELSE base.lg_logistics END AS b_logistics,
    COALESCE((SELECT SUM(COALESCE((e->>'amount')::numeric,0)) FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(base.cb->'extras')='array' THEN base.cb->'extras' ELSE '[]'::jsonb END) e),0) AS b_extras,
    CASE WHEN upper(COALESCE(base.currency,'CNY')) IN ('CNY','RMB') THEN COALESCE(base.total_revenue,0)
         WHEN COALESCE(base.exchange_rate,0)>0 THEN COALESCE(base.total_revenue,0)*base.exchange_rate ELSE NULL END AS revenue_cny,
    (base.order_no ~* '^(CPX-|W1D-|TEST)' OR COALESCE(base.customer_company,'') ILIKE '%测试%'
     OR lower(trim(COALESCE(base.customer_company,'')))='test') AS is_junk
  FROM base LEFT JOIN qty ON qty.budget_order_id=base.id LEFT JOIN actual ON actual.budget_order_id=base.id
)
SELECT id, order_no, order_date, delivery_date, status, currency, exchange_rate,
  customer_id, customer_company, customer_country, qimo_order_id, notes,
  created_at, approved_at, ar_received_amount, ar_received_at, ar_received_bank,
  estimated_profit, estimated_margin,
  quantity, is_junk, has_breakdown, total_revenue, revenue_cny,
  ROUND(COALESCE(total_cost,0),2) AS cost_cny,
  ROUND(lg_purchase,2) AS lg_purchase, ROUND(lg_processing,2) AS lg_processing,
  ROUND(lg_forwarder,2) AS lg_forwarder, ROUND(lg_container,2) AS lg_container, ROUND(lg_logistics,2) AS lg_logistics,
  ROUND(b_finished_goods,2) AS c_finished_goods, ROUND(b_fabric,2) AS c_fabric, ROUND(b_accessory,2) AS c_accessory,
  ROUND(b_processing,2) AS c_processing, ROUND(b_forwarder,2) AS c_forwarder, ROUND(b_container,2) AS c_container,
  ROUND(b_logistics,2) AS c_logistics, ROUND(b_extras,2) AS c_extras,
  ROUND(b_finished_goods+b_fabric+b_accessory+b_processing+b_forwarder+b_container+b_logistics+b_extras,2) AS bucket_total,
  ROUND(actual_cost_cny,2) AS actual_cost_cny, actual_lines,
  (revenue_cny IS NULL) AS missing_rate,
  CASE WHEN revenue_cny IS NOT NULL AND revenue_cny>0 THEN ROUND(revenue_cny-COALESCE(total_cost,0),2) END AS profit_cny,
  CASE WHEN revenue_cny IS NOT NULL AND revenue_cny>0 THEN ROUND((revenue_cny-COALESCE(total_cost,0))/revenue_cny*100,2) END AS margin_pct,
  ((b_finished_goods>0)::int+(b_fabric>0)::int+(b_accessory>0)::int+(b_processing>0)::int
   +(b_forwarder>0)::int+(b_container>0)::int+(b_logistics>0)::int) AS filled_buckets,
  (b_forwarder>0 OR b_container>0 OR b_logistics>0) AS has_shipping_cost,
  CASE WHEN ((b_finished_goods>0)::int+(b_fabric>0)::int+(b_accessory>0)::int+(b_processing>0)::int
        +(b_forwarder>0)::int+(b_container>0)::int+(b_logistics>0)::int)=0 THEN 'none'
       WHEN NOT (b_forwarder>0 OR b_container>0 OR b_logistics>0) THEN 'minimal'
       WHEN ((b_finished_goods>0)::int+(b_fabric>0)::int+(b_accessory>0)::int+(b_processing>0)::int
        +(b_forwarder>0)::int+(b_container>0)::int+(b_logistics>0)::int)>=5 THEN 'full'
       ELSE 'partial' END AS cost_completeness
FROM calc;
ALTER VIEW public.v_order_financials SET (security_invoker = true);
REVOKE ALL ON public.v_order_financials FROM PUBLIC;
REVOKE ALL ON public.v_order_financials FROM anon;
GRANT SELECT ON public.v_order_financials TO authenticated;

-- 自验证:重建后 security_invoker 必须仍为 true(漏设=匿名可读全量财务数据)
DO $$
DECLARE v text;
BEGIN
  SELECT c.reloptions::text INTO v FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
   WHERE ns.nspname='public' AND c.relname='v_order_financials';
  IF v IS NULL OR v NOT LIKE '%security_invoker=true%' THEN
    RAISE EXCEPTION '重建后 security_invoker 未生效,reloptions=%', COALESCE(v,'(null)');
  END IF;
  RAISE NOTICE '✓ v_order_financials 已扩展且安全属性保持';
END $$;
