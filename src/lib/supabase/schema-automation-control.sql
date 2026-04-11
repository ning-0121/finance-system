-- ============================================================
-- 企业级自动化控制 — 执行日志 + 人工覆盖 + 规则版本
-- ============================================================

-- 1. 规则执行日志
CREATE TABLE IF NOT EXISTS public.rule_execution_logs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_id uuid REFERENCES public.automation_rules(id),
  rule_name text NOT NULL,
  execution_id text NOT NULL,
  trigger_time timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL DEFAULT 'system' CHECK (actor IN ('system', 'user', 'cron')),
  environment text NOT NULL DEFAULT 'live' CHECK (environment IN ('live', 'dry_run')),
  condition_result jsonb,
  entities_matched jsonb,
  actions_taken jsonb,
  result text NOT NULL CHECK (result IN ('success', 'partial', 'failed', 'skipped', 'dry_run', 'conflict', 'overridden')),
  explanation text,
  duration_ms integer,
  created_at timestamptz DEFAULT now()
);

-- 2. 人工覆盖记录
CREATE TABLE IF NOT EXISTS public.manual_overrides (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  override_type text NOT NULL CHECK (override_type IN ('force_approve', 'force_unfreeze', 'force_trust_upgrade', 'bypass_blocked', 'force_execute', 'force_rollback', 'skip_rule')),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  original_state jsonb,
  new_state jsonb,
  reason text NOT NULL,
  overridden_by uuid REFERENCES public.profiles(id),
  overridden_at timestamptz DEFAULT now(),
  rule_id uuid REFERENCES public.automation_rules(id),
  impact_assessment text,
  created_at timestamptz DEFAULT now()
);

-- 3. ALTER automation_rules 增加版本+灰度字段
ALTER TABLE public.automation_rules ADD COLUMN IF NOT EXISTS version_number integer DEFAULT 1;
ALTER TABLE public.automation_rules ADD COLUMN IF NOT EXISTS previous_config jsonb;
ALTER TABLE public.automation_rules ADD COLUMN IF NOT EXISTS changed_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.automation_rules ADD COLUMN IF NOT EXISTS changed_at timestamptz;
ALTER TABLE public.automation_rules ADD COLUMN IF NOT EXISTS grayscale_config jsonb;
ALTER TABLE public.automation_rules ADD COLUMN IF NOT EXISTS is_draft boolean DEFAULT false;

-- 索引
CREATE INDEX IF NOT EXISTS idx_exec_logs_rule ON public.rule_execution_logs(rule_id);
CREATE INDEX IF NOT EXISTS idx_exec_logs_execution ON public.rule_execution_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_exec_logs_result ON public.rule_execution_logs(result);
CREATE INDEX IF NOT EXISTS idx_exec_logs_time ON public.rule_execution_logs(trigger_time DESC);
CREATE INDEX IF NOT EXISTS idx_overrides_entity ON public.manual_overrides(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_overrides_rule ON public.manual_overrides(rule_id);

-- RLS
ALTER TABLE public.rule_execution_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.manual_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "exec_logs_all" ON public.rule_execution_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "overrides_all" ON public.manual_overrides FOR ALL USING (true) WITH CHECK (true);
