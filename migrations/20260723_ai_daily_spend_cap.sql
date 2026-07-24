-- ===== 2026-07-23 AI 日花费硬性封顶(财务系统)=====
-- 每次调 Anthropic 前累加当日全系统花费,达上限暂停(次日 UTC 归零自动恢复)。
-- 上限:app_config.ai_daily_cap_usd 覆盖 env AI_DAILY_CAP_USD(默认 $5)。

CREATE TABLE IF NOT EXISTS public.ai_spend_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spend_date date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  cost_usd   numeric NOT NULL DEFAULT 0,
  model      text,
  scene      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_spend_log_date ON public.ai_spend_log (spend_date);

-- append-only,仅 service-role 读写(封顶逻辑用 service-role,绕过 RLS)
ALTER TABLE public.ai_spend_log ENABLE ROW LEVEL SECURITY;

-- 极简配置单例表(可 SQL 改额度,免重部署)
CREATE TABLE IF NOT EXISTS public.app_config (
  id               text PRIMARY KEY DEFAULT 'singleton',
  ai_daily_cap_usd numeric,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
INSERT INTO public.app_config (id, ai_daily_cap_usd) VALUES ('singleton', 5)
  ON CONFLICT (id) DO NOTHING;
