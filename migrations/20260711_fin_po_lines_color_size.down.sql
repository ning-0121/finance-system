-- 回滚：采购行 颜色/尺码
ALTER TABLE public.fin_po_lines DROP COLUMN IF EXISTS size;
ALTER TABLE public.fin_po_lines DROP COLUMN IF EXISTS color;
