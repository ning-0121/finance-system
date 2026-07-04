-- 回滚：恢复 accounting_periods 全开放策略
DROP POLICY IF EXISTS periods_read ON public.accounting_periods;
DROP POLICY IF EXISTS periods_write_mgr ON public.accounting_periods;
DROP POLICY IF EXISTS periods_insert_mgr ON public.accounting_periods;
CREATE POLICY periods_all ON public.accounting_periods FOR ALL TO authenticated USING (true) WITH CHECK (true);
