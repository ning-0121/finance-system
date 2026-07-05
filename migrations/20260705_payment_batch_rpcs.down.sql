-- 回滚 20260705_payment_batch_rpcs.sql
DROP FUNCTION IF EXISTS public.create_payment_batch(uuid,text,date,text,text,text);
DROP FUNCTION IF EXISTS public.add_payment_batch_line(uuid,uuid,numeric,uuid);
DROP FUNCTION IF EXISTS public.remove_payment_batch_line(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.submit_payment_batch(uuid,uuid);
DROP FUNCTION IF EXISTS public.approve_payment_batch(uuid,uuid);
DROP FUNCTION IF EXISTS public.execute_batch_line_payment(uuid,uuid,text,date,text);
DROP FUNCTION IF EXISTS public.close_payment_batch(uuid,uuid);
DROP FUNCTION IF EXISTS public.cancel_payment_batch(uuid,uuid,text);
