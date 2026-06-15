-- ============================================================
-- Phase 2 #3：财务可信度中心 — 巡检结果表
-- 每次巡检（每日 cron / 手动）一行：总分 + 分维度得分 + 检查明细 jsonb。
-- 异常明细落 audit_findings（复用既有三级分级与处理流）。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS public.integrity_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('cron','manual','closing')),
  score numeric(5,2) NOT NULL,                -- 总评分 0-100
  dimension_scores jsonb NOT NULL DEFAULT '{}'::jsonb, -- {completeness, consistency, uniqueness, timeliness}
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,           -- 总量卡：各单据数量
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,           -- 检查明细 [{key,label,status,severity,detail,count,varianceCny}]
  critical_count int NOT NULL DEFAULT 0,
  warning_count int NOT NULL DEFAULT 0,
  info_count int NOT NULL DEFAULT 0,
  summary_text text,
  created_by uuid REFERENCES public.profiles(id),      -- 手动触发人；cron 为 null
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrity_runs_at ON public.integrity_runs (run_at DESC);

ALTER TABLE public.integrity_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integrity_runs_read  ON public.integrity_runs;
DROP POLICY IF EXISTS integrity_runs_write ON public.integrity_runs;
CREATE POLICY integrity_runs_read ON public.integrity_runs
  FOR SELECT TO authenticated USING (true);
CREATE POLICY integrity_runs_write ON public.integrity_runs
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_staff','finance_manager','admin'));

-- 验证：
-- SELECT count(*) FROM public.integrity_runs;
