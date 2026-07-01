-- ============================================================
-- 付款审批与出纳：应付记录补充字段
--  - payment_channel  付款方式：公账/私账/支付宝/微信（可筛选）
--  - payee_name       收款人名称（默认取供应商信息库户名，可改）
--  - payee_account    收款银行账号
--  - payee_bank       开户行
-- 均为可空补充列，可加可逆（回滚见 .down.sql）。软删除复用已有 deleted_at。
-- ============================================================
ALTER TABLE public.payable_records ADD COLUMN IF NOT EXISTS payment_channel text;
ALTER TABLE public.payable_records ADD COLUMN IF NOT EXISTS payee_name text;
ALTER TABLE public.payable_records ADD COLUMN IF NOT EXISTS payee_account text;
ALTER TABLE public.payable_records ADD COLUMN IF NOT EXISTS payee_bank text;

-- 取值约束（仅约束已知渠道，NULL 允许——历史数据不阻断）
ALTER TABLE public.payable_records DROP CONSTRAINT IF EXISTS payable_records_payment_channel_chk;
ALTER TABLE public.payable_records ADD CONSTRAINT payable_records_payment_channel_chk
  CHECK (payment_channel IS NULL OR payment_channel IN ('company','personal','alipay','wechat'));
