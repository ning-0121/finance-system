-- ============================================================
-- 收紧会计期间 RLS：锁账/解锁属财务主管动作
-- 背景(审计 P1)：accounting_periods 策略为 FOR ALL USING(true)，任何登录角色
--   (含销售)都能锁账/解锁生产账期，且绕过月结检查。改为：读人人；
--   写(锁账/解锁)仅 finance_manager/admin。可加可逆(回滚见 .down.sql)。
-- ============================================================
ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS periods_all ON public.accounting_periods;
DROP POLICY IF EXISTS periods_read ON public.accounting_periods;
DROP POLICY IF EXISTS periods_write_mgr ON public.accounting_periods;
DROP POLICY IF EXISTS periods_insert_mgr ON public.accounting_periods;

CREATE POLICY periods_read ON public.accounting_periods
  FOR SELECT TO authenticated USING (true);
CREATE POLICY periods_write_mgr ON public.accounting_periods
  FOR UPDATE TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));
CREATE POLICY periods_insert_mgr ON public.accounting_periods
  FOR INSERT TO authenticated
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));
