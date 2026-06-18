-- 回滚 收款汇率修正 RPC
DROP FUNCTION IF EXISTS public.correct_receivable_payment_rate(uuid,uuid,numeric,text,numeric,date,text,uuid,text);
