-- ============================================================
-- 付款防重复(硬约束)：supplier_payments 加 付款凭证号 + 部分唯一索引
-- 背景：直接记付款此前只有"同额查重弹窗"(可被点确认绕过)。加凭证号(银行流水号/
--   转账回单号/发票号)后，同一供应商同一凭证号 DB 层直接拒，重复付款无法落库。
-- 部分唯一：payment_ref 非空且未软删时生效，允许多条无凭证号的历史/零星付款。
-- 加法式、可空、幂等；回滚见 .down.sql。
-- 前置(可选自查有无历史重复)：
--   SELECT supplier_name, payment_ref, count(*) FROM public.supplier_payments
--     WHERE payment_ref IS NOT NULL AND deleted_at IS NULL
--     GROUP BY supplier_name, payment_ref HAVING count(*) > 1;
-- ============================================================
ALTER TABLE public.supplier_payments ADD COLUMN IF NOT EXISTS payment_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_supplier_ref_uniq
  ON public.supplier_payments (supplier_name, payment_ref)
  WHERE payment_ref IS NOT NULL AND deleted_at IS NULL;
