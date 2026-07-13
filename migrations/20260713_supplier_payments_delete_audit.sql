-- ============================================================
-- supplier_payments 加删除留痕列(审计P1:deleteSupplierPayment 此前不记谁删/为何删)
-- 可加可逆。
-- ============================================================
ALTER TABLE public.supplier_payments ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.supplier_payments ADD COLUMN IF NOT EXISTS delete_reason text;
-- 验证: SELECT column_name FROM information_schema.columns WHERE table_name='supplier_payments' AND column_name IN ('deleted_by','delete_reason');
