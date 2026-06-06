-- 回滚 回款流水层（财务级修正版）
DROP FUNCTION IF EXISTS public.void_receivable_payment(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.unallocate_receivable_payment(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.allocate_receivable_payment(uuid, uuid, numeric, numeric, uuid);
DROP TRIGGER IF EXISTS trg_alloc_recalc ON public.receivable_payment_allocations;
DROP TRIGGER IF EXISTS trg_alloc_no_over ON public.receivable_payment_allocations;
DROP FUNCTION IF EXISTS public._trg_alloc_recalc();
DROP FUNCTION IF EXISTS public._trg_alloc_no_over();
DROP FUNCTION IF EXISTS public._recalc_receipt_match(uuid);
DROP FUNCTION IF EXISTS public._refresh_order_ar_projection(uuid);
DROP TABLE IF EXISTS public.receivable_payment_allocations;
DROP TABLE IF EXISTS public.receivable_payments;
