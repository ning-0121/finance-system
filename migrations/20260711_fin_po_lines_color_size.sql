-- ============================================================
-- 采购行 加 颜色/尺码 —— 财务审批按色核数量(同料多色行此前无法区分)
-- 节拍器已随行推 color/size(color 由 procurement_items 回查),财务侧此前丢弃。
-- 可加可逆,回滚见 .down.sql
-- ============================================================

ALTER TABLE public.fin_po_lines ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.fin_po_lines ADD COLUMN IF NOT EXISTS size text;

-- 验证：
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='fin_po_lines' AND column_name IN ('color','size');
