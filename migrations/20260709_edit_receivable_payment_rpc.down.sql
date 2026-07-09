-- 回滚 回款流水编辑 RPC
DROP FUNCTION IF EXISTS public.edit_receivable_payment(uuid,date,text,text,text,numeric,text,numeric,uuid,text);
