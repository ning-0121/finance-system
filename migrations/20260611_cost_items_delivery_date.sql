-- ============================================================
-- 费用归集：送货日期列（财务对账用，可自行选择；区别于系统录入时间 created_at）
-- 可加可逆。回滚见 .down.sql
-- ============================================================
ALTER TABLE public.cost_items ADD COLUMN IF NOT EXISTS delivery_date date;

-- 历史数据回填：用录入日做初值（中国时区取日），财务可在编辑里逐笔改成真实送货日期
UPDATE public.cost_items
SET delivery_date = (created_at AT TIME ZONE 'Asia/Shanghai')::date
WHERE delivery_date IS NULL;

-- 验证：
-- SELECT column_name FROM information_schema.columns WHERE table_name='cost_items' AND column_name='delivery_date';
-- SELECT count(*) FROM public.cost_items WHERE delivery_date IS NULL;  -- 应为 0
