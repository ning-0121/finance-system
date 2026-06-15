-- 回滚 异常中心认领字段
DROP INDEX IF EXISTS public.idx_audit_findings_status_sev;
ALTER TABLE public.audit_findings DROP COLUMN IF EXISTS assigned_at;
ALTER TABLE public.audit_findings DROP COLUMN IF EXISTS assigned_to;
