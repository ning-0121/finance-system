-- ============================================================
-- 重复付款防控 A：应付单据号 + 唯一约束（防同一票货代费/账单付两次）
-- bill_no = 货代账单号 / 报关单号 / 发票号。同一供应商同一单据号只允许一条应付。
-- 部分唯一索引：bill_no 非空时生效，允许多条无单据号的历史/零星应付。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

ALTER TABLE public.payable_records ADD COLUMN IF NOT EXISTS bill_no text;

-- 若历史已有同供应商同单据号重复，先人工处理（下面查询列出）；建唯一索引会因重复失败
-- SELECT supplier_name, bill_no, count(*) FROM public.payable_records
--   WHERE bill_no IS NOT NULL GROUP BY supplier_name, bill_no HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS payable_records_supplier_bill_uniq
  ON public.payable_records (supplier_name, bill_no)
  WHERE bill_no IS NOT NULL;

-- 验证：
-- SELECT column_name FROM information_schema.columns WHERE table_name='payable_records' AND column_name='bill_no';
