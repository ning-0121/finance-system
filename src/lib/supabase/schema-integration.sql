-- ============================================================
-- 集成模块 Schema — 订单节拍器 <-> 财务系统
-- ============================================================

-- 同步订单表（从节拍器接收的订单摘要）
create table public.synced_orders (
  id uuid primary key,                    -- 节拍器 orders.id
  order_no text not null unique,          -- QM-YYYYMMDD-XXX
  customer_name text not null,
  incoterm text,
  delivery_type text,
  order_type text,
  lifecycle_status text not null,
  po_number text,
  currency text,
  unit_price numeric(15,2),
  total_amount numeric(15,2),
  quantity numeric(15,2),
  quantity_unit text,
  factory_name text,
  etd date,
  payment_terms text,
  style_no text,
  notes text,
  source_created_by uuid,                -- 节拍器用户ID
  source_created_at timestamptz,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  -- 财务系统关联
  budget_order_id uuid references public.budget_orders(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 待审批表（从节拍器接收的审批请求）
create table public.pending_approvals (
  id uuid primary key,                    -- 节拍器 approval.id
  approval_type text not null check (approval_type in ('price', 'delay', 'cancel')),
  order_no text not null,
  customer_name text,
  requested_by_name text not null,
  summary text not null,
  detail jsonb not null default '{}'::jsonb,
  form_snapshot jsonb,
  expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_by text,                        -- 财务系统审批人ID
  decider_name text,                      -- 财务系统审批人名
  decision_note text,
  decided_at timestamptz,
  source_created_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 集成日志表（完整审计追踪）
create table public.integration_logs (
  id uuid primary key default uuid_generate_v4(),
  event_type text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  request_id text not null,
  source text not null,
  status text not null check (status in ('success', 'failed', 'pending')),
  payload_summary text,
  error_message text,
  created_at timestamptz not null default now()
);

-- RLS
alter table public.synced_orders enable row level security;
alter table public.pending_approvals enable row level security;
alter table public.integration_logs enable row level security;

create policy "Users can view synced_orders" on public.synced_orders for select using (true);
create policy "Service can manage synced_orders" on public.synced_orders for all using (true);

create policy "Users can view pending_approvals" on public.pending_approvals for select using (true);
create policy "Service can manage pending_approvals" on public.pending_approvals for all using (true);

create policy "Users can view integration_logs" on public.integration_logs for select using (true);
create policy "Service can insert integration_logs" on public.integration_logs for insert with check (true);

-- 索引
create index idx_synced_orders_order_no on public.synced_orders(order_no);
create index idx_synced_orders_status on public.synced_orders(lifecycle_status);
create index idx_pending_approvals_status on public.pending_approvals(status);
create index idx_pending_approvals_type on public.pending_approvals(approval_type);
create index idx_integration_logs_event on public.integration_logs(event_type, created_at desc);
create index idx_integration_logs_request on public.integration_logs(request_id);

-- 更新触发器
create trigger update_synced_orders_updated_at before update on public.synced_orders for each row execute procedure public.update_updated_at();
create trigger update_pending_approvals_updated_at before update on public.pending_approvals for each row execute procedure public.update_updated_at();
