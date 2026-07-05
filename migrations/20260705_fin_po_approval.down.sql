-- 回滚 20260705_fin_po_approval.sql
DROP INDEX IF EXISTS public.idx_fin_po_approval;
ALTER TABLE public.fin_purchase_orders
  DROP COLUMN IF EXISTS requires_approval,
  DROP COLUMN IF EXISTS approval_decided_by,
  DROP COLUMN IF EXISTS approval_decided_at,
  DROP COLUMN IF EXISTS approval_note,
  DROP COLUMN IF EXISTS approval_callback_at;
ALTER TABLE public.fin_purchase_orders DROP CONSTRAINT IF EXISTS fin_po_fin_status_chk;
-- 回退前把新态归一,避免旧约束拒绝
UPDATE public.fin_purchase_orders SET fin_status='pending'
  WHERE fin_status IN ('pending_approval','approved','rejected');
ALTER TABLE public.fin_purchase_orders ADD CONSTRAINT fin_po_fin_status_chk
  CHECK (fin_status IN ('pending','registered','ignored'));
