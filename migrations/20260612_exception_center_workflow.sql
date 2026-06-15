-- ============================================================
-- Phase 2 #4：异常中心 — audit_findings 处理闭环字段
-- 复用现有 audit_findings（已有 status open/investigating/resolved/dismissed
-- + resolved_by/resolved_at/resolution_note）。仅补「认领」字段。
-- 可加可逆，回滚见 .down.sql
-- ============================================================
ALTER TABLE public.audit_findings ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.profiles(id);
ALTER TABLE public.audit_findings ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

-- 按状态+严重度筛选的复合索引（异常中心列表主查询路径）
CREATE INDEX IF NOT EXISTS idx_audit_findings_status_sev
  ON public.audit_findings (status, severity, created_at DESC);

-- 验证：
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='audit_findings' AND column_name IN ('assigned_to','assigned_at');
