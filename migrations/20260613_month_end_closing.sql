-- ============================================================
-- Phase 2 #6：月结中心增强
-- ① month_end_snapshots：锁账时固化月度经营数字（锁账产物，老板月报数据源）
-- ② accounting_periods 增解锁审批字段（财务经理发起 → admin 批准）
-- 可加可逆，回滚见 .down.sql
-- ============================================================

-- ① 月结快照
CREATE TABLE IF NOT EXISTS public.month_end_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code text NOT NULL UNIQUE,
  panel jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 订单数/已决算/收入/成本/利润/毛利率/应收/应付/回款率 等
  closed_by uuid REFERENCES public.profiles(id),
  closed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.month_end_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS month_end_read       ON public.month_end_snapshots;
DROP POLICY IF EXISTS month_end_write_fin  ON public.month_end_snapshots;
CREATE POLICY month_end_read ON public.month_end_snapshots
  FOR SELECT TO authenticated USING (true);
CREATE POLICY month_end_write_fin ON public.month_end_snapshots
  FOR ALL TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- ② 解锁审批字段
ALTER TABLE public.accounting_periods ADD COLUMN IF NOT EXISTS reopen_requested_by uuid REFERENCES public.profiles(id);
ALTER TABLE public.accounting_periods ADD COLUMN IF NOT EXISTS reopen_requested_at timestamptz;
ALTER TABLE public.accounting_periods ADD COLUMN IF NOT EXISTS reopen_reason text;

-- 验证：
-- SELECT count(*) FROM public.month_end_snapshots;
-- SELECT column_name FROM information_schema.columns WHERE table_name='accounting_periods' AND column_name LIKE 'reopen%';
