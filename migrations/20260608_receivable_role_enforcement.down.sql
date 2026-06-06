-- 回滚 回款角色鉴权：恢复试运行期的宽松 RLS（写操作 TO authenticated），删除争议 RPC。
-- 注：3 个 RPC 内的角色判断对 service role / auth.uid()=NULL 无影响；如需完全去除 RPC 内角色判断，
--     重跑 20260607_receivable_payments.sql 的 RPC 段即可。_app_role() 保留（RPC 仍引用）。

DROP FUNCTION IF EXISTS public.set_receivable_dispute(uuid, boolean, uuid, text);

DROP POLICY IF EXISTS receivable_payments_ins ON public.receivable_payments;
CREATE POLICY receivable_payments_ins ON public.receivable_payments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY receivable_payments_upd ON public.receivable_payments FOR UPDATE TO authenticated USING (true);
CREATE POLICY receivable_payments_del ON public.receivable_payments FOR DELETE TO authenticated USING (true);
CREATE POLICY receivable_payment_allocations_ins ON public.receivable_payment_allocations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY receivable_payment_allocations_upd ON public.receivable_payment_allocations FOR UPDATE TO authenticated USING (true);
CREATE POLICY receivable_payment_allocations_del ON public.receivable_payment_allocations FOR DELETE TO authenticated USING (true);
