-- ============================================================
-- 审计修复：出口退税报关单号唯一约束（防重复申报/重复退税）
-- 同一报关单号只允许一条退税记录。部分唯一索引（customs_no 非空时生效），
-- 允许多条 customs_no 为空的草稿行。
-- 先清重再建索引；可加可逆，回滚见 .down.sql
-- ============================================================

-- 若已有重复报关单号，先人工处理（下面查询列出重复项；建索引会因重复失败）
-- SELECT customs_no, count(*) FROM public.tax_refunds WHERE customs_no IS NOT NULL GROUP BY customs_no HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS tax_refunds_customs_no_uniq
  ON public.tax_refunds (customs_no)
  WHERE customs_no IS NOT NULL;

-- 验证：
-- \d+ public.tax_refunds  -- 确认 tax_refunds_customs_no_uniq 存在
