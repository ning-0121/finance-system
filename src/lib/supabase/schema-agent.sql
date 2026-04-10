-- ============================================================
-- 财务Agent层 Schema — 在财务系统的 Supabase SQL Editor 中执行
-- ============================================================

-- ============================================================
-- 1. 客户财务画像
-- ============================================================
create table if not exists public.customer_financial_profiles (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references public.customers(id),
  customer_name text not null,
  avg_payment_days numeric(5,1) default 0,
  overdue_rate numeric(5,2) default 0,
  average_order_profit_rate numeric(5,2) default 0,
  deduction_frequency int default 0,
  late_confirmation_frequency int default 0,
  invoice_dispute_frequency int default 0,
  bad_debt_score numeric(5,2) default 0,
  dependency_score numeric(5,2) default 0,
  total_outstanding numeric(15,2) default 0,
  credit_limit numeric(15,2) default 0,
  risk_level text not null default 'B' check (risk_level in ('A','B','C','D','E')),
  last_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 2. 供应商财务画像
-- ============================================================
create table if not exists public.supplier_financial_profiles (
  id uuid primary key default uuid_generate_v4(),
  supplier_name text not null unique,
  avg_payment_term_days numeric(5,1) default 30,
  avg_delay_tolerance_days numeric(5,1) default 7,
  historical_stop_supply_count int default 0,
  urgency_score numeric(5,2) default 50,
  dependency_score numeric(5,2) default 50,
  risk_level text not null default 'B' check (risk_level in ('A','B','C','D','E')),
  preferred_payment_method text default 'bank_transfer',
  current_outstanding numeric(15,2) default 0,
  next_due_amount numeric(15,2) default 0,
  next_due_date date,
  last_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 3. 现金流预测
-- ============================================================
create table if not exists public.cashflow_forecasts (
  id uuid primary key default uuid_generate_v4(),
  forecast_date date not null,
  expected_inflow numeric(15,2) not null default 0,
  expected_outflow numeric(15,2) not null default 0,
  expected_cash_balance numeric(15,2) not null default 0,
  warning_level text not null default 'safe' check (warning_level in ('safe','attention','danger','critical')),
  top_risk_reason text,
  suggested_action text,
  scenario text not null default 'normal' check (scenario in ('normal','conservative','extreme')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 4. 财务风险事件
-- ============================================================
create table if not exists public.financial_risk_events (
  id uuid primary key default uuid_generate_v4(),
  risk_type text not null check (risk_type in (
    'overdue_payment','low_profit_order','abnormal_material_cost',
    'supplier_delay','insufficient_cashflow','customer_high_dependency',
    'exchange_rate_risk','tax_risk','duplicate_payment','invoice_mismatch'
  )),
  risk_level text not null default 'yellow' check (risk_level in ('red','yellow','green')),
  related_order_id uuid,
  related_customer_id uuid,
  related_supplier_name text,
  title text not null,
  description text not null,
  suggested_action text,
  owner_role text default 'finance_manager',
  status text not null default 'pending' check (status in ('pending','processing','resolved','ignored')),
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 5. Agent 动作日志
-- ============================================================
create table if not exists public.financial_agent_actions (
  id uuid primary key default uuid_generate_v4(),
  action_type text not null check (action_type in (
    'send_collection_reminder','generate_payment_plan','create_cashflow_alert',
    'recommend_hold_shipment','recommend_pause_order','recommend_reduce_credit',
    'auto_match_payment','auto_risk_detection','generate_daily_report',
    'update_customer_profile','update_supplier_profile','escalate_to_boss'
  )),
  target_type text,
  target_id text,
  summary text not null,
  detail jsonb default '{}'::jsonb,
  execution_result text check (execution_result in ('success','failed','pending_approval','skipped')),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- RLS
-- ============================================================
alter table public.customer_financial_profiles enable row level security;
alter table public.supplier_financial_profiles enable row level security;
alter table public.cashflow_forecasts enable row level security;
alter table public.financial_risk_events enable row level security;
alter table public.financial_agent_actions enable row level security;

create policy "view_customer_profiles" on public.customer_financial_profiles for select using (true);
create policy "manage_customer_profiles" on public.customer_financial_profiles for all using (true);
create policy "view_supplier_profiles" on public.supplier_financial_profiles for select using (true);
create policy "manage_supplier_profiles" on public.supplier_financial_profiles for all using (true);
create policy "view_cashflow" on public.cashflow_forecasts for select using (true);
create policy "manage_cashflow" on public.cashflow_forecasts for all using (true);
create policy "view_risk_events" on public.financial_risk_events for select using (true);
create policy "manage_risk_events" on public.financial_risk_events for all using (true);
create policy "view_agent_actions" on public.financial_agent_actions for select using (true);
create policy "manage_agent_actions" on public.financial_agent_actions for all using (true);

-- ============================================================
-- 索引
-- ============================================================
create index if not exists idx_customer_profiles_risk on public.customer_financial_profiles(risk_level);
create index if not exists idx_supplier_profiles_risk on public.supplier_financial_profiles(risk_level);
create index if not exists idx_cashflow_date on public.cashflow_forecasts(forecast_date, scenario);
create index if not exists idx_risk_events_status on public.financial_risk_events(status, risk_level);
create index if not exists idx_risk_events_type on public.financial_risk_events(risk_type);
create index if not exists idx_agent_actions_type on public.financial_agent_actions(action_type, created_at desc);
