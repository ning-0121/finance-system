-- ============================================================
-- 财务控制中台 — 6大控制中心统一SQL
-- 7张表 + 索引 + RLS
-- ============================================================

-- 1. 月结检查清单
CREATE TABLE IF NOT EXISTS public.period_close_checklists (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  period_code text NOT NULL,
  close_type text NOT NULL CHECK (close_type IN ('month', 'year')),
  check_key text NOT NULL,
  check_label text NOT NULL,
  check_order integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'skipped', 'overridden')),
  result jsonb,
  executed_at timestamptz,
  executed_by uuid REFERENCES public.profiles(id),
  override_reason text,
  approved_by uuid REFERENCES public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(period_code, check_key)
);

-- 2. 稽核异常
CREATE TABLE IF NOT EXISTS public.audit_findings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  finding_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  entity_type text NOT NULL,
  entity_id text,
  title text NOT NULL,
  description text NOT NULL,
  evidence jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  resolved_by uuid REFERENCES public.profiles(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz DEFAULT now()
);

-- 3. 冻结记录
CREATE TABLE IF NOT EXISTS public.entity_freezes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  entity_name text NOT NULL,
  freeze_reason text NOT NULL,
  freeze_type text NOT NULL DEFAULT 'manual' CHECK (freeze_type IN ('manual', 'auto_breaker', 'auto_audit', 'auto_trust')),
  trigger_source text,
  status text NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen', 'unfrozen')),
  frozen_by uuid REFERENCES public.profiles(id),
  frozen_at timestamptz DEFAULT now(),
  unfreeze_requested_by uuid REFERENCES public.profiles(id),
  unfreeze_requested_at timestamptz,
  unfrozen_by uuid REFERENCES public.profiles(id),
  unfrozen_at timestamptz,
  unfreeze_reason text,
  created_at timestamptz DEFAULT now()
);

-- 4. 通用时间线
CREATE TABLE IF NOT EXISTS public.entity_timeline (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  event_type text NOT NULL,
  event_title text NOT NULL,
  event_detail jsonb,
  field_changes jsonb,
  source_type text CHECK (source_type IN ('user', 'agent', 'system', 'document_engine', 'import', 'api')),
  source_id text,
  actor_id uuid REFERENCES public.profiles(id),
  actor_name text,
  created_at timestamptz DEFAULT now()
);

-- 5. 模拟场景
CREATE TABLE IF NOT EXISTS public.simulation_scenarios (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  scenario_type text NOT NULL CHECK (scenario_type IN ('fx_change', 'cost_increase', 'customer_loss', 'supply_disruption', 'demand_change', 'custom')),
  parameters jsonb NOT NULL,
  base_snapshot jsonb NOT NULL,
  simulated_result jsonb NOT NULL,
  impact_summary text NOT NULL,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz DEFAULT now()
);

-- 6. 信任历史
CREATE TABLE IF NOT EXISTS public.trust_score_history (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  trust_level text NOT NULL,
  trust_score numeric NOT NULL,
  score_breakdown jsonb,
  change_reason text,
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz DEFAULT now()
);

-- 7. 扩展 automation_trust_scores
DO $$ BEGIN
  ALTER TABLE public.automation_trust_scores ADD COLUMN IF NOT EXISTS score_breakdown jsonb;
  ALTER TABLE public.automation_trust_scores ADD COLUMN IF NOT EXISTS trend text DEFAULT 'stable';
  ALTER TABLE public.automation_trust_scores ADD COLUMN IF NOT EXISTS last_downgrade_reason text;
  ALTER TABLE public.automation_trust_scores ADD COLUMN IF NOT EXISTS auto_freeze_triggered boolean DEFAULT false;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- 索引
CREATE INDEX IF NOT EXISTS idx_checklist_period ON public.period_close_checklists(period_code);
CREATE INDEX IF NOT EXISTS idx_audit_findings_status ON public.audit_findings(status);
CREATE INDEX IF NOT EXISTS idx_audit_findings_severity ON public.audit_findings(severity);
CREATE INDEX IF NOT EXISTS idx_entity_freezes_type ON public.entity_freezes(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_freezes_status ON public.entity_freezes(status);
CREATE INDEX IF NOT EXISTS idx_timeline_entity ON public.entity_timeline(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_created ON public.entity_timeline(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_history ON public.trust_score_history(subject_type, subject_id, snapshot_date DESC);

-- RLS
ALTER TABLE public.period_close_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_freezes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.simulation_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trust_score_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "checklist_all" ON public.period_close_checklists FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "findings_all" ON public.audit_findings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "freezes_all" ON public.entity_freezes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "timeline_all" ON public.entity_timeline FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "scenarios_all" ON public.simulation_scenarios FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "trust_history_all" ON public.trust_score_history FOR ALL USING (true) WITH CHECK (true);
