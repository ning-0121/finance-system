-- ============================================================
-- 外贸财务系统 - 数据库Schema
-- ============================================================

-- 启用UUID扩展
create extension if not exists "uuid-ossp";

-- ============================================================
-- 用户档案表
-- ============================================================
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  name text not null default '',
  role text not null default 'finance_staff' check (role in ('admin', 'finance_manager', 'finance_staff', 'sales', 'procurement', 'cashier')),
  department text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 新用户注册时自动创建档案
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- 客户表
-- ============================================================
create table public.customers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  company text not null,
  contact text,
  email text,
  phone text,
  country text,
  currency text not null default 'USD',
  credit_limit numeric(15,2),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 产品表
-- ============================================================
create table public.products (
  id uuid primary key default uuid_generate_v4(),
  sku text not null unique,
  name text not null,
  category text,
  unit text not null default 'PCS',
  default_price numeric(15,2),
  specifications text,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 预算单表
-- ============================================================
create table public.budget_orders (
  id uuid primary key default uuid_generate_v4(),
  order_no text not null unique,
  customer_id uuid not null references public.customers(id),
  order_date date not null default current_date,
  delivery_date date,
  items jsonb not null default '[]'::jsonb,
  target_purchase_price numeric(15,2) not null default 0,
  estimated_freight numeric(15,2) not null default 0,
  estimated_commission numeric(15,2) not null default 0,
  estimated_customs_fee numeric(15,2) not null default 0,
  other_costs numeric(15,2) not null default 0,
  total_revenue numeric(15,2) not null default 0,
  total_cost numeric(15,2) not null default 0,
  estimated_profit numeric(15,2) not null default 0,
  estimated_margin numeric(5,2) not null default 0,
  currency text not null default 'USD',
  exchange_rate numeric(10,4) not null default 1,
  status text not null default 'draft' check (status in ('draft', 'pending_review', 'approved', 'rejected', 'closed')),
  created_by uuid not null references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  notes text,
  attachments jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 自动生成订单号
create or replace function public.generate_order_no()
returns trigger as $$
declare
  prefix text;
  seq_no int;
begin
  prefix := 'BO-' || to_char(now(), 'YYYYMM') || '-';
  select coalesce(max(cast(substring(order_no from length(prefix)+1) as integer)), 0) + 1
  into seq_no
  from public.budget_orders
  where order_no like prefix || '%';
  new.order_no := prefix || lpad(seq_no::text, 4, '0');
  return new;
end;
$$ language plpgsql;

create trigger set_budget_order_no
  before insert on public.budget_orders
  for each row
  when (new.order_no is null or new.order_no = '')
  execute procedure public.generate_order_no();

-- ============================================================
-- 结算单表
-- ============================================================
create table public.settlement_orders (
  id uuid primary key default uuid_generate_v4(),
  order_no text not null unique,
  budget_order_id uuid not null references public.budget_orders(id),
  actual_purchase_cost numeric(15,2) not null default 0,
  actual_freight numeric(15,2) not null default 0,
  actual_commission numeric(15,2) not null default 0,
  actual_customs_fee numeric(15,2) not null default 0,
  other_actual_costs numeric(15,2) not null default 0,
  total_actual_cost numeric(15,2) not null default 0,
  actual_revenue numeric(15,2) not null default 0,
  actual_profit numeric(15,2) not null default 0,
  actual_margin numeric(5,2) not null default 0,
  variance_amount numeric(15,2) not null default 0,
  variance_percentage numeric(5,2) not null default 0,
  variance_analysis jsonb default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'locked')),
  settled_by uuid references public.profiles(id),
  settled_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 费用项表
-- ============================================================
create table public.cost_items (
  id uuid primary key default uuid_generate_v4(),
  budget_order_id uuid references public.budget_orders(id),
  settlement_order_id uuid references public.settlement_orders(id),
  cost_type text not null check (cost_type in ('freight', 'commission', 'customs', 'procurement', 'other')),
  description text not null,
  amount numeric(15,2) not null,
  currency text not null default 'USD',
  exchange_rate numeric(10,4) not null default 1,
  source_module text,
  source_id text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 审批记录表
-- ============================================================
create table public.approval_logs (
  id uuid primary key default uuid_generate_v4(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null check (action in ('submit', 'approve', 'reject', 'revoke')),
  from_status text not null,
  to_status text not null,
  operator_id uuid not null references public.profiles(id),
  comment text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 预警表
-- ============================================================
create table public.alerts (
  id uuid primary key default uuid_generate_v4(),
  type text not null check (type in ('margin_low', 'cost_overrun', 'payment_overdue', 'variance_high')),
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  title text not null,
  message text not null,
  entity_type text not null,
  entity_id uuid not null,
  is_read boolean not null default false,
  user_id uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row Level Security (RLS)
-- ============================================================
alter table public.profiles enable row level security;
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.budget_orders enable row level security;
alter table public.settlement_orders enable row level security;
alter table public.cost_items enable row level security;
alter table public.approval_logs enable row level security;
alter table public.alerts enable row level security;

-- 所有已登录用户可查看基础数据
create policy "Users can view all profiles" on public.profiles for select using (true);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

create policy "Users can view customers" on public.customers for select using (true);
create policy "Users can manage customers" on public.customers for all using (true);

create policy "Users can view products" on public.products for select using (true);
create policy "Users can manage products" on public.products for all using (true);

create policy "Users can view budget_orders" on public.budget_orders for select using (true);
create policy "Users can manage budget_orders" on public.budget_orders for all using (true);

create policy "Users can view settlement_orders" on public.settlement_orders for select using (true);
create policy "Users can manage settlement_orders" on public.settlement_orders for all using (true);

create policy "Users can view cost_items" on public.cost_items for select using (true);
create policy "Users can manage cost_items" on public.cost_items for all using (true);

create policy "Users can view approval_logs" on public.approval_logs for select using (true);
create policy "Users can insert approval_logs" on public.approval_logs for insert with check (true);

create policy "Users can view own alerts" on public.alerts for select using (true);
create policy "Users can update own alerts" on public.alerts for update using (true);
create policy "Users can insert alerts" on public.alerts for insert with check (true);

-- ============================================================
-- 索引
-- ============================================================
create index idx_budget_orders_customer on public.budget_orders(customer_id);
create index idx_budget_orders_status on public.budget_orders(status);
create index idx_budget_orders_created on public.budget_orders(created_at desc);
create index idx_settlement_orders_budget on public.settlement_orders(budget_order_id);
create index idx_cost_items_budget on public.cost_items(budget_order_id);
create index idx_cost_items_settlement on public.cost_items(settlement_order_id);
create index idx_approval_logs_entity on public.approval_logs(entity_type, entity_id);
create index idx_alerts_user on public.alerts(user_id, is_read);

-- ============================================================
-- 更新时间触发器
-- ============================================================
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_profiles_updated_at before update on public.profiles for each row execute procedure public.update_updated_at();
create trigger update_customers_updated_at before update on public.customers for each row execute procedure public.update_updated_at();
create trigger update_products_updated_at before update on public.products for each row execute procedure public.update_updated_at();
create trigger update_budget_orders_updated_at before update on public.budget_orders for each row execute procedure public.update_updated_at();
create trigger update_settlement_orders_updated_at before update on public.settlement_orders for each row execute procedure public.update_updated_at();
