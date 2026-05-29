-- ============================================================
-- 供应商付款流水表 — 供「供应商对账单」记录按供应商的付款（负数流水）
-- ============================================================
-- 设计：独立新表，不触碰任何现有表（cost_items / payable_records 等），
--       对生产零影响。付款只挂供应商，不挂订单号（符合对账单需求）。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.supplier_payments (
  id            uuid primary key default gen_random_uuid(),
  supplier_name text not null,
  amount        numeric(15,2) not null,          -- 付款金额（正数存储，对账单展示为负数）
  currency      text not null default 'CNY',
  paid_at       date,                            -- 付款日期
  note          text,                            -- 备注（付款方式/凭证号等）
  created_by    uuid,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz                      -- 软删除（与系统其它财务实体一致）
);

COMMENT ON TABLE public.supplier_payments IS '供应商付款流水：按供应商记录已付货款，用于对账单滚动余额（实际未付=费用合计−付款合计）';

CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON public.supplier_payments(supplier_name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_supplier_payments_paid_at  ON public.supplier_payments(paid_at)       WHERE deleted_at IS NULL;
