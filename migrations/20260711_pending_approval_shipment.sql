-- 放行 pending_approvals.approval_type = 'shipment'
-- 出货财务审批进「集成审批」队列(节拍器业务申请出货 → 财务队列 → 批/驳回传)。
-- 2026-07-11 已在生产执行并验证 PASS(约束定义含 'shipment')。
-- 注:循环变量用 rec、表别名用 c,避免与 record 撞名(旧 con/con 撞名会报 55000)。
DO $do$
DECLARE rec record;
BEGIN
  FOR rec IN
    SELECT c.conname AS conname
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'pending_approvals'
      AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%approval_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.pending_approvals DROP CONSTRAINT %I', rec.conname);
  END LOOP;
  ALTER TABLE public.pending_approvals ADD CONSTRAINT pending_approvals_approval_type_check
    CHECK (approval_type IN ('price','delay','cancel','milestone','shipment'));
END $do$;

-- 验证:期望返回的定义含 'shipment'
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='pending_approvals_approval_type_check';
