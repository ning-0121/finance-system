-- 回滚 C3：移除 supplier_payments 的 RLS 策略并关闭 RLS
-- 注意：关闭后该表恢复为「无 RLS」状态（anon 仍可访问，与迁移前一致）。

DROP POLICY IF EXISTS "supplier_payments_select" ON public.supplier_payments;
DROP POLICY IF EXISTS "supplier_payments_insert" ON public.supplier_payments;
DROP POLICY IF EXISTS "supplier_payments_update" ON public.supplier_payments;
DROP POLICY IF EXISTS "supplier_payments_delete" ON public.supplier_payments;

ALTER TABLE public.supplier_payments DISABLE ROW LEVEL SECURITY;
