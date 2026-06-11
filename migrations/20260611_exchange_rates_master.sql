-- ============================================================
-- Phase 2 #2b：汇率主数据表
-- 结构与现有消费方 /api/profit/fx 的查询完全对齐
-- （base_currency / quote_currency / rate / fetched_at），建表即激活该接口。
-- 用途：全系统统一汇率来源，逐步替换散落的 ||7 / 7.1 / 7.15 / 7.24 写死值；
--       期末汇兑重估改为取本表最新汇率，取不到则拒绝生成草稿（绝不臆造汇率入 GL）。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency  text NOT NULL DEFAULT 'USD',
  quote_currency text NOT NULL DEFAULT 'CNY',
  rate numeric(10,4) NOT NULL CHECK (rate > 0),
  rate_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Shanghai')::date),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','bank','api')),
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_currency, quote_currency, rate_date)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup
  ON public.exchange_rates (base_currency, quote_currency, fetched_at DESC);

-- RLS：登录可读；财务角色可写（与核心表同口径）
ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exchange_rates_read       ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_insert_fin ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_update_fin ON public.exchange_rates;
DROP POLICY IF EXISTS exchange_rates_delete_mgr ON public.exchange_rates;
CREATE POLICY exchange_rates_read ON public.exchange_rates
  FOR SELECT TO authenticated USING (true);
CREATE POLICY exchange_rates_insert_fin ON public.exchange_rates
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY exchange_rates_update_fin ON public.exchange_rates
  FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));
CREATE POLICY exchange_rates_delete_mgr ON public.exchange_rates
  FOR DELETE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- 录入今日汇率示例（财务在 SQL Editor 或后续界面执行）：
-- INSERT INTO public.exchange_rates (base_currency, quote_currency, rate, source, notes)
-- VALUES ('USD','CNY', 7.2400, 'manual', '中行中间价');

-- 验证：
-- SELECT * FROM public.exchange_rates ORDER BY fetched_at DESC LIMIT 5;
