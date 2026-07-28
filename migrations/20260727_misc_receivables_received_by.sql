-- 杂项应收收款留痕:加 received_by(记确认收款的真实财务人 auth.uid(),铁律)。附加、可逆。⚠️ 财务库执行。
ALTER TABLE public.misc_receivables
  ADD COLUMN IF NOT EXISTS received_by uuid REFERENCES public.profiles(id);
