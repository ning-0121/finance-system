-- ============================================================
-- 工资条发放（导入算好的工资表 → 生成工资条 → 企业微信私发）
-- 不含工资计算（社保/个税引擎）。薪资数据敏感：
--   payroll_batches/payroll_slips 仅 finance_manager + admin 可读写（财务员看不到）。
--   employees 花名册：登录可读（姓名/部门非密），财务经理/管理员可写。
-- 可加可逆，回滚见 .down.sql
-- ============================================================

-- ① 员工花名册（企业微信通讯录同步进来，提供 wecom_userid 作工资条收件人）
CREATE TABLE IF NOT EXISTS public.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  wecom_userid text UNIQUE,          -- 企业微信成员ID，工资条 touser
  department text,
  email text,
  mobile text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employees_name ON public.employees (name);

-- ② 工资批次（一个发薪期一批）
CREATE TABLE IF NOT EXISTS public.payroll_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code text NOT NULL,         -- 如 2026-06
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  slip_count int NOT NULL DEFAULT 0,
  sent_count int NOT NULL DEFAULT 0,
  total_net numeric(15,2) NOT NULL DEFAULT 0,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ③ 工资条（每人一条）
CREATE TABLE IF NOT EXISTS public.payroll_slips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.payroll_batches(id) ON DELETE CASCADE,
  employee_name text NOT NULL,
  wecom_userid text,                 -- 匹配花名册得到；空=无法私发
  net_pay numeric(15,2) NOT NULL DEFAULT 0,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{label, amount}] 工资条各项（应发项+扣减项）
  send_status text NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending','sent','failed','skipped')),
  sent_at timestamptz,
  send_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_slips_batch ON public.payroll_slips (batch_id);

-- RLS
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employees_read ON public.employees;
DROP POLICY IF EXISTS employees_write ON public.employees;
CREATE POLICY employees_read ON public.employees FOR SELECT TO authenticated USING (true);
CREATE POLICY employees_write ON public.employees FOR ALL TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

ALTER TABLE public.payroll_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_batches_all ON public.payroll_batches;
CREATE POLICY payroll_batches_all ON public.payroll_batches FOR ALL TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

ALTER TABLE public.payroll_slips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payroll_slips_all ON public.payroll_slips;
CREATE POLICY payroll_slips_all ON public.payroll_slips FOR ALL TO authenticated
  USING (coalesce(public._app_role(),'none') IN ('finance_manager','admin'))
  WITH CHECK (coalesce(public._app_role(),'none') IN ('finance_manager','admin'));

-- 验证：
-- SELECT count(*) FROM public.employees;
-- SELECT column_name FROM information_schema.columns WHERE table_name='payroll_slips';
