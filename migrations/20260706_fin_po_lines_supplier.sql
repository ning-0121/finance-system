-- ============================================================
-- fin_po_lines 补 供应商列(采购行级)——预算"原辅料按供应商分组"的源
-- 老板口径:一张订单的原辅料分别下给不同供应商;节拍器已改为【按行】发 supplier_id/supplier_name。
-- 但 fin_po_lines 只有 material/category/amount,没有行级供应商列 → 财务把每行供应商丢了,
-- 预算无法按"哪个供应商、什么料、多少钱"拼原辅料。补上行级供应商。
-- (fin_purchase_orders 头上的 supplier 是整单一个,拆不到料行级,故必须落在行上。)
-- 加法式、可空、幂等。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
ALTER TABLE public.fin_po_lines
  ADD COLUMN IF NOT EXISTS supplier_id   text,
  ADD COLUMN IF NOT EXISTS supplier_name text;

CREATE INDEX IF NOT EXISTS idx_fin_po_lines_supplier ON public.fin_po_lines(supplier_name);

DO $do$ BEGIN RAISE NOTICE '✓ fin_po_lines 已补 supplier_id/supplier_name(预算原辅料按供应商分组的源)'; END $do$;
