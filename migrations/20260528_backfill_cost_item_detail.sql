-- ============================================================
-- 可选回填：历史 cost_items 的 数量/单位/单价 从 source_id(JSON) 复制到真实列
-- ============================================================
-- 背景：早期「费用归集」把 {qty,unit,unit_price} 存进 source_id(文本JSON)，
--       而「订单核算单」支区读取的是 quantity/unit/unit_price 列。
--       本脚本把历史数据补进真实列，让旧订单的核算单也能显示明细。
--
-- 安全性：
--   - 仅填充 quantity 为空的行（不覆盖已有列值）
--   - 逐行容错：source_id 不是合法 JSON 的行（如 Excel 导入存的文件名）自动跳过
--   - 不删除、不修改 source_id 本身
--   - 可重复执行（已填充的行 quantity 不再为空，自动跳过）
-- ============================================================

DO $$
DECLARE r RECORD; j jsonb;
BEGIN
  FOR r IN
    SELECT id, source_id FROM public.cost_items
    WHERE quantity IS NULL
      AND source_id IS NOT NULL
      AND left(btrim(source_id), 1) = '{'
  LOOP
    BEGIN
      j := r.source_id::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;  -- 非合法 JSON，跳过
    END;
    IF (j ? 'qty') OR (j ? 'unit_price') THEN
      UPDATE public.cost_items
         SET quantity   = COALESCE(NULLIF(j->>'qty', '')::numeric, quantity),
             unit       = COALESCE(NULLIF(j->>'unit', ''), unit),
             unit_price = COALESCE(NULLIF(j->>'unit_price', '')::numeric, unit_price)
       WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
