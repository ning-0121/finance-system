-- ============================================================
-- pending_approvals 放行 milestone 类型(审计:cancel/milestone 审批链接通)
-- 原 CHECK 只允许 price/delay/cancel;接通里程碑财务确认需加 'milestone'。
-- (cancel 本就在约束内,只差 webhook 接收端——代码侧已加 handleGenericApprovalRequest。)
-- 加法式、幂等。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
DO $do$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'public.pending_approvals'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%approval_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.pending_approvals DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.pending_approvals ADD CONSTRAINT pending_approvals_approval_type_check
    CHECK (approval_type IN ('price','delay','cancel','milestone'));
END $do$;

DO $do$ BEGIN RAISE NOTICE 'pending_approvals.approval_type 已放行 milestone(cancel/milestone 审批链财务侧就绪)'; END $do$;
