-- 20260711 付款凭证图片 —— 出纳放款后可附「银行回单/转账截图」,已付行显示可查看。纯增量、可回滚。
-- 背景:出纳放款只记凭证号(payment_ref 文本),用户要在已付行看到付款凭证【图片】。
-- 存储:图片进私有桶 finance-attachments,表里只存路径(payment_proof_path)。
-- 不改动 execute_batch_line_payment(动线上付款函数风险高)——放款照旧,凭证图片单独一步附加/补传。
-- ⚠️ 人工在财务库 Supabase 执行。
-- 回滚见 .down.sql。

alter table public.payment_batch_lines add column if not exists payment_proof_path text;
comment on column public.payment_batch_lines.payment_proof_path is '付款凭证图片路径(finance-attachments 私有桶;银行回单/转账截图)。展示时生成签名URL。';

alter table public.supplier_payments add column if not exists payment_proof_path text;
comment on column public.supplier_payments.payment_proof_path is '付款凭证图片路径(与排款行同步;付款流水的回单图)。';

-- 附加/补传付款凭证图片(出纳/财务/管理员)。仅对【已付】排款行;同步写到对应 supplier_payments。
-- SECURITY DEFINER:payment_batch_lines/supplier_payments 走 RPC 网关写(直写被 RLS 挡)。
CREATE OR REPLACE FUNCTION public.set_batch_line_payment_proof(
  p_line_id uuid, p_actor uuid, p_proof_path text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_actor uuid := public._finance_actor_guard(p_actor, ARRAY['finance_staff','finance_manager','admin']);
  v_line record;
  v_path text := nullif(trim(p_proof_path), '');
BEGIN
  SELECT * INTO v_line FROM public.payment_batch_lines WHERE id = p_line_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LINE_NOT_FOUND: 排款行不存在'; END IF;
  IF v_line.status <> 'paid' THEN RAISE EXCEPTION 'NOT_PAID: 仅已付款的行可附凭证图片(当前 %)', v_line.status; END IF;

  UPDATE public.payment_batch_lines SET payment_proof_path = v_path WHERE id = p_line_id;
  -- 同步到实付流水(付款完成时按 source_batch_line_id 生成的那条)
  UPDATE public.supplier_payments SET payment_proof_path = v_path WHERE source_batch_line_id = p_line_id;

  RETURN jsonb_build_object('id', p_line_id, 'payment_proof_path', v_path);
END $fn$;

GRANT EXECUTE ON FUNCTION public.set_batch_line_payment_proof(uuid, uuid, text) TO authenticated;

-- 验证:
--   SELECT column_name FROM information_schema.columns WHERE table_name='payment_batch_lines' AND column_name='payment_proof_path';
--   SELECT proname FROM pg_proc WHERE proname='set_batch_line_payment_proof';
