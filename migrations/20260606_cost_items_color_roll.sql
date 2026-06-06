-- ============================================================
-- 费用明细新增「颜色 color」「匹数 roll_count」字段
-- 原则：不从历史「品名」字符串硬拆颜色/匹数（避免假准确）。
-- 历史数据 color / roll_count 为 NULL；以后录入时分开填。
-- 可加可逆。
-- 回滚见 20260606_cost_items_color_roll.down.sql
-- ============================================================

ALTER TABLE public.cost_items ADD COLUMN IF NOT EXISTS color      text;
ALTER TABLE public.cost_items ADD COLUMN IF NOT EXISTS roll_count numeric(12,2);

-- 验证：
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='cost_items' AND column_name IN ('color','roll_count');
