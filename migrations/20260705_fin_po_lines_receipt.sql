-- ============================================================
-- fin_po_lines 补收货列(审计 P1:goods_receipt 静默丢)
-- 收货回财务(goods_receipt.recorded)要按 line_id 写实收到 fin_po_lines,但这几列一直没建 →
-- 每次 update 报「列不存在」→ 旧代码吞成 done → 收货静默蒸发。补列后 happy path 可写;
-- 配合 handler 改为「写失败/0行匹配 → ignored(inbox 留 pending 可重试)」不再假成功。
-- 加法式、可空、幂等。⚠️ 财务库(qpoboelobqnfbytugzkw)执行。
-- ============================================================
ALTER TABLE public.fin_po_lines
  ADD COLUMN IF NOT EXISTS received_qty       numeric,
  ADD COLUMN IF NOT EXISTS inspection_result  text,
  ADD COLUMN IF NOT EXISTS received_at        timestamptz;

DO $do$ BEGIN RAISE NOTICE '✓ fin_po_lines 已补 received_qty/inspection_result/received_at'; END $do$;
