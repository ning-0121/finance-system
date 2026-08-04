-- 回滚:供应商待扣款台账(20260803_supplier_deductions)
-- ⚠️ 回滚会丢掉全部待扣款记录。若已有 pending/applied 记录,先导出备查:
--   SELECT supplier_name, event_type, amount, status, reason, occurred_at
--     FROM public.supplier_deductions WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS public.idx_supplier_deductions_pending;
DROP INDEX IF EXISTS public.idx_supplier_deductions_order;
DROP INDEX IF EXISTS public.idx_supplier_deductions_po;
DROP TABLE IF EXISTS public.supplier_deductions;
