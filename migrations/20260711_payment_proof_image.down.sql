-- 回滚 20260711_payment_proof_image
DROP FUNCTION IF EXISTS public.set_batch_line_payment_proof(uuid, uuid, text);
ALTER TABLE public.payment_batch_lines DROP COLUMN IF EXISTS payment_proof_path;
ALTER TABLE public.supplier_payments DROP COLUMN IF EXISTS payment_proof_path;
