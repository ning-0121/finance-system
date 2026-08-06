-- ============================================================
-- 订单财务口径视图 v_order_financials(2026-08-06)
--
-- 目的:把「拉 639 行 1.6MB 到浏览器再聚合」搬到数据库。十个页面都在前端全量拉取,
--   叠加中国→美国机房的往返延迟,页面明显卡顿(老板反馈)。
--
-- 选【普通视图】而非物化视图:数据量仅几百行,普通视图足够快;
--   而物化视图有刷新滞后 —— 财务数字宁可慢也不能旧(收了款报表还显示未收会出事)。
--   将来数据量上来再 CREATE MATERIALIZED VIEW 并加刷新任务即可,查询侧不用改。
--
-- ⚠️ 口径必须与 TS 侧逐条对齐(lib/financial/*),否则同一个数两处算出两个值:
--   ① 收入CNY:人民币单直取;外币 = 原币 × 汇率;【外币缺汇率 → NULL】不按 1:1 猜。
--   ② 成本桶:优先 items[0]._cost_breakdown;完全无 breakdown 的历史单才回退标量列。
--      ⚠ target_purchase_price = 采购成品+面料+辅料(揉在一起),故只在无 breakdown 时用,
--        且只能整体记到 fabric —— 这正是 2026-08-06 修掉的那个 bug 的成因。
--   ③ 测试单:CPX-/W1D-/TEST 前缀,或客户名含「测试」/等于 test。
--   ④ 成本完整度:填了几个桶 + 是否含出运成本(货代/装柜/物流)。
--
-- 只读视图,不改任何表。回滚见 .down.sql。⚠️ 财务库执行。
-- ============================================================

CREATE OR REPLACE VIEW public.v_order_financials AS
WITH base AS (
  SELECT
    b.id, b.order_no, b.order_date, b.status, b.currency, b.exchange_rate,
    b.total_revenue, b.total_cost, b.customer_id,
    c.company AS customer_company, c.country AS customer_country,
    b.items -> 0 -> '_cost_breakdown' AS cb,
    -- 旧标量列(仅无 breakdown 时回退)
    COALESCE(b.target_purchase_price, 0)   AS lg_purchase,
    COALESCE(b.estimated_commission, 0)    AS lg_processing,
    COALESCE(b.estimated_freight, 0)       AS lg_forwarder,
    COALESCE(b.estimated_customs_fee, 0)   AS lg_container,
    COALESCE(b.other_costs, 0)             AS lg_logistics
  FROM public.budget_orders b
  LEFT JOIN public.customers c ON c.id = b.customer_id
  WHERE b.deleted_at IS NULL
),
qty AS (   -- 件数在 synced_orders 上(budget_orders 无数量列);一单可能对多条镜像,故求和
  SELECT budget_order_id, SUM(COALESCE(quantity, 0))::numeric AS quantity
  FROM public.synced_orders WHERE budget_order_id IS NOT NULL GROUP BY budget_order_id
),
actual AS (  -- 实际费用归集(票点不计成本);外币缺率的行按 0 计,不猜
  SELECT budget_order_id,
         SUM(COALESCE(amount,0) * CASE
               WHEN upper(COALESCE(currency,'CNY')) IN ('CNY','RMB') THEN 1
               WHEN COALESCE(exchange_rate,0) > 0 THEN exchange_rate ELSE 0 END)::numeric AS actual_cost_cny,
         COUNT(*)::int AS actual_lines
  FROM public.cost_items
  WHERE deleted_at IS NULL AND cost_type <> 'tax_point'
  GROUP BY budget_order_id
),
calc AS (
  SELECT base.*,
    COALESCE(qty.quantity, 0) AS quantity,
    COALESCE(actual.actual_cost_cny, 0) AS actual_cost_cny,
    COALESCE(actual.actual_lines, 0)    AS actual_lines,
    (base.cb IS NOT NULL) AS has_breakdown,
    -- 逐桶:有 breakdown 以桶为准(0 也是有效值),无 breakdown 才回退标量
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb ->> 'finished_goods')::numeric, 0) ELSE 0 END AS b_finished_goods,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb ->> 'fabric')::numeric, 0)         ELSE base.lg_purchase   END AS b_fabric,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb ->> 'accessory')::numeric, 0)      ELSE 0 END AS b_accessory,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb ->> 'processing')::numeric, 0)     ELSE base.lg_processing END AS b_processing,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb ->> 'forwarder')::numeric, 0)      ELSE base.lg_forwarder  END AS b_forwarder,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb ->> 'container')::numeric, 0)      ELSE base.lg_container  END AS b_container,
    CASE WHEN base.cb IS NOT NULL THEN COALESCE((base.cb ->> 'logistics')::numeric, 0)      ELSE base.lg_logistics  END AS b_logistics,
    COALESCE((SELECT SUM(COALESCE((e ->> 'amount')::numeric, 0))
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(base.cb -> 'extras') = 'array'
                                             THEN base.cb -> 'extras' ELSE '[]'::jsonb END) e), 0) AS b_extras,
    -- 收入折 CNY:外币缺率给 NULL(下游 SUM 会自动跳过,且能据此统计"缺汇率"张数)
    CASE
      WHEN upper(COALESCE(base.currency,'CNY')) IN ('CNY','RMB') THEN COALESCE(base.total_revenue,0)
      WHEN COALESCE(base.exchange_rate,0) > 0 THEN COALESCE(base.total_revenue,0) * base.exchange_rate
      ELSE NULL
    END AS revenue_cny,
    -- 测试/垃圾单
    (base.order_no ~* '^(CPX-|W1D-|TEST)'
      OR COALESCE(base.customer_company,'') ILIKE '%测试%'
      OR lower(trim(COALESCE(base.customer_company,''))) = 'test') AS is_junk
  FROM base
  LEFT JOIN qty    ON qty.budget_order_id = base.id
  LEFT JOIN actual ON actual.budget_order_id = base.id
)
SELECT
  id, order_no, order_date, status, currency, exchange_rate,
  customer_id, customer_company, customer_country,
  quantity, is_junk, has_breakdown,
  total_revenue, revenue_cny,
  ROUND(COALESCE(total_cost,0), 2) AS cost_cny,
  ROUND(b_finished_goods,2) AS c_finished_goods, ROUND(b_fabric,2) AS c_fabric,
  ROUND(b_accessory,2) AS c_accessory, ROUND(b_processing,2) AS c_processing,
  ROUND(b_forwarder,2) AS c_forwarder, ROUND(b_container,2) AS c_container,
  ROUND(b_logistics,2) AS c_logistics, ROUND(b_extras,2) AS c_extras,
  ROUND(b_finished_goods + b_fabric + b_accessory + b_processing
        + b_forwarder + b_container + b_logistics + b_extras, 2) AS bucket_total,
  ROUND(actual_cost_cny, 2) AS actual_cost_cny, actual_lines,
  (revenue_cny IS NULL) AS missing_rate,
  CASE WHEN revenue_cny IS NOT NULL AND revenue_cny > 0
       THEN ROUND(revenue_cny - COALESCE(total_cost,0), 2) END AS profit_cny,
  CASE WHEN revenue_cny IS NOT NULL AND revenue_cny > 0
       THEN ROUND((revenue_cny - COALESCE(total_cost,0)) / revenue_cny * 100, 2) END AS margin_pct,
  -- 填了几个成本桶 + 是否含出运成本 → 完整度分档(与 TS costCompletenessOf 同口径)
  ((b_finished_goods > 0)::int + (b_fabric > 0)::int + (b_accessory > 0)::int + (b_processing > 0)::int
   + (b_forwarder > 0)::int + (b_container > 0)::int + (b_logistics > 0)::int) AS filled_buckets,
  (b_forwarder > 0 OR b_container > 0 OR b_logistics > 0) AS has_shipping_cost,
  CASE
    WHEN ((b_finished_goods > 0)::int + (b_fabric > 0)::int + (b_accessory > 0)::int + (b_processing > 0)::int
          + (b_forwarder > 0)::int + (b_container > 0)::int + (b_logistics > 0)::int) = 0 THEN 'none'
    WHEN NOT (b_forwarder > 0 OR b_container > 0 OR b_logistics > 0) THEN 'minimal'
    WHEN ((b_finished_goods > 0)::int + (b_fabric > 0)::int + (b_accessory > 0)::int + (b_processing > 0)::int
          + (b_forwarder > 0)::int + (b_container > 0)::int + (b_logistics > 0)::int) >= 5 THEN 'full'
    ELSE 'partial'
  END AS cost_completeness
FROM calc;

COMMENT ON VIEW public.v_order_financials IS
  '订单财务口径(每单一行):收入折CNY、成本七桶、实际归集、完整度分档、测试单标记。口径与 lib/financial/* 对齐,改口径两处都要改。';

GRANT SELECT ON public.v_order_financials TO authenticated;

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM public.v_order_financials;
  RAISE NOTICE '✓ v_order_financials 已就绪,当前 % 行', v;
END $$;
