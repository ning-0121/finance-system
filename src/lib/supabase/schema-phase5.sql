-- ============================================================
-- Phase 5: 动作级确认 + 准确率反馈 — 在Supabase执行
-- ============================================================

-- 增强 document_actions 表
ALTER TABLE public.document_actions
  ADD COLUMN IF NOT EXISTS decision text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS decision_reason text,
  ADD COLUMN IF NOT EXISTS decided_by text,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_role text,
  ADD COLUMN IF NOT EXISTS safety_level text,
  ADD COLUMN IF NOT EXISTS explanation jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS impact_detail jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS execution_record_id text,
  ADD COLUMN IF NOT EXISTS rollback_status text DEFAULT 'none';

-- 准确率反馈事件表
CREATE TABLE IF NOT EXISTS public.accuracy_feedback_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id uuid REFERENCES public.uploaded_documents(id),
  event_type text NOT NULL CHECK (event_type IN ('field_corrected','action_rejected','action_rolled_back','template_failed')),
  field_name text,
  action_type text,
  original_value text,
  corrected_value text,
  doc_category text,
  entity_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.accuracy_feedback_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "v_feedback" ON public.accuracy_feedback_events FOR SELECT USING (true);
CREATE POLICY "m_feedback" ON public.accuracy_feedback_events FOR ALL USING (true);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON public.accuracy_feedback_events(event_type, field_name);
CREATE INDEX IF NOT EXISTS idx_feedback_doc ON public.accuracy_feedback_events(document_id);
