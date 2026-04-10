-- ============================================================
-- Phase 6: 信任分层 — 在Supabase SQL Editor执行
-- ============================================================

CREATE TABLE IF NOT EXISTS public.automation_trust_scores (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_type text NOT NULL CHECK (subject_type IN ('customer','supplier','template','action_type','owner')),
  subject_id text NOT NULL,
  trust_score integer NOT NULL DEFAULT 50,
  trust_level text NOT NULL DEFAULT 'T2' CHECK (trust_level IN ('T0','T1','T2','T3','T4','T5')),
  total_events integer NOT NULL DEFAULT 0,
  correct_events integer NOT NULL DEFAULT 0,
  rejected_events integer NOT NULL DEFAULT 0,
  rollback_events integer NOT NULL DEFAULT 0,
  last_calculated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_type, subject_id)
);

ALTER TABLE public.automation_trust_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "v_trust" ON public.automation_trust_scores FOR SELECT USING (true);
CREATE POLICY "m_trust" ON public.automation_trust_scores FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_trust_type ON public.automation_trust_scores(subject_type, trust_level);
