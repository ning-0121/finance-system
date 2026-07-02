-- ============================================================
-- 加固：出纳付款→供应商付款流水的同步幂等（防重复已付）
-- 背景：原幂等靠 note ILIKE '%payable:<id>%' 模糊匹配，note 可被编辑/清空 →
--       幂等失效 → 同一笔付款同步出第二条、已付翻倍，且无 DB 兜底。
-- 方案：加结构化外键列 source_payable_id + 部分唯一索引（未软删时唯一），
--       同步按此列判重、DB 兜底防重复。
-- 可加可逆（回滚见 .down.sql）。
-- ============================================================
ALTER TABLE public.supplier_payments ADD COLUMN IF NOT EXISTS source_payable_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_source_payable_uniq
  ON public.supplier_payments (source_payable_id)
  WHERE source_payable_id IS NOT NULL AND deleted_at IS NULL;
