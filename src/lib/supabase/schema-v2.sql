-- ============================================================
-- 外贸财务系统 V2 — 订单全生命周期子单据体系
-- 在财务系统的 Supabase SQL Editor 中执行
-- ============================================================

-- 修改现有表
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS quote_no text;
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS po_no text;
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS has_sub_documents boolean not null default false;

-- ============================================================
-- 1. 预算子单据表
-- ============================================================
create table if not exists public.budget_sub_documents (
  id uuid primary key default uuid_generate_v4(),
  budget_order_id uuid not null references public.budget_orders(id) on delete cascade,
  doc_type text not null check (doc_type in (
    'raw_material', 'auxiliary_material', 'factory_processing',
    'logistics', 'commission', 'tax', 'other'
  )),
  doc_no text,
  supplier_name text,
  items jsonb not null default '[]'::jsonb,
  estimated_total numeric(15,2) not null default 0,
  currency text not null default 'USD',
  exchange_rate numeric(10,4) not null default 1,
  status text not null default 'draft' check (status in ('draft', 'approved', 'executing', 'settled')),
  actual_total numeric(15,2),
  variance numeric(15,2),
  settlement_note text,
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 2. 实际单据/发票表
-- ============================================================
create table if not exists public.actual_invoices (
  id uuid primary key default uuid_generate_v4(),
  budget_order_id uuid not null references public.budget_orders(id),
  sub_document_id uuid references public.budget_sub_documents(id),
  invoice_type text not null check (invoice_type in (
    'purchase_order', 'supplier_invoice', 'factory_contract',
    'factory_statement', 'freight_bill', 'commission_bill',
    'customer_statement', 'tax_invoice', 'other_invoice'
  )),
  invoice_no text not null,
  supplier_name text,
  items jsonb not null default '[]'::jsonb,
  total_amount numeric(15,2) not null,
  currency text not null default 'USD',
  exchange_rate numeric(10,4) not null default 1,
  invoice_date date,
  due_date date,
  over_budget boolean not null default false,
  over_budget_reason text,
  over_budget_approved_by uuid references public.profiles(id),
  over_budget_approved_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'approved', 'paid', 'disputed')),
  attachment_url text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 3. 出货单据表
-- ============================================================
create table if not exists public.shipping_documents (
  id uuid primary key default uuid_generate_v4(),
  budget_order_id uuid not null references public.budget_orders(id),
  doc_type text not null check (doc_type in (
    'pi', 'ci', 'packing_list', 'customs_declaration', 'tax_refund'
  )),
  document_no text not null,
  items jsonb not null default '[]'::jsonb,
  total_amount numeric(15,2) not null default 0,
  currency text not null default 'USD',
  status text not null default 'draft' check (status in ('draft', 'submitted', 'completed')),
  attachment_url text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 4. 剩余物料/次品入库表
-- ============================================================
create table if not exists public.inventory_returns (
  id uuid primary key default uuid_generate_v4(),
  budget_order_id uuid not null references public.budget_orders(id),
  sub_document_id uuid references public.budget_sub_documents(id),
  return_type text not null check (return_type in (
    'raw_material', 'auxiliary', 'finished_good', 'defective'
  )),
  items jsonb not null default '[]'::jsonb,
  total_value numeric(15,2) not null default 0,
  warehouse_location text,
  accounting_treatment text not null default 'reduce_cost' check (accounting_treatment in (
    'add_to_cost', 'reduce_cost', 'scrap'
  )),
  processed_by uuid references public.profiles(id),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 5. 订单决算单表
-- ============================================================
create table if not exists public.order_settlements (
  id uuid primary key default uuid_generate_v4(),
  budget_order_id uuid not null references public.budget_orders(id) unique,
  sub_settlements jsonb not null default '[]'::jsonb,
  order_level_costs jsonb not null default '[]'::jsonb,
  total_budget numeric(15,2) not null default 0,
  total_actual numeric(15,2) not null default 0,
  total_variance numeric(15,2) not null default 0,
  inventory_credit numeric(15,2) not null default 0,
  final_profit numeric(15,2) not null default 0,
  final_margin numeric(5,2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'locked')),
  settled_by uuid references public.profiles(id),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- 6. 供应商对账汇总视图
-- ============================================================
create or replace view public.supplier_statement_view as
select
  supplier_name,
  date_trunc('month', invoice_date) as period,
  count(*) as invoice_count,
  sum(total_amount) as total_amount,
  sum(case when status = 'paid' then total_amount else 0 end) as paid_amount,
  sum(case when status != 'paid' then total_amount else 0 end) as unpaid_amount,
  array_agg(distinct budget_order_id) as order_ids,
  min(invoice_date) as earliest_date,
  max(invoice_date) as latest_date
from public.actual_invoices
where supplier_name is not null
group by supplier_name, date_trunc('month', invoice_date)
order by period desc, supplier_name;

-- ============================================================
-- RLS
-- ============================================================
alter table public.budget_sub_documents enable row level security;
alter table public.actual_invoices enable row level security;
alter table public.shipping_documents enable row level security;
alter table public.inventory_returns enable row level security;
alter table public.order_settlements enable row level security;

create policy "Users can view budget_sub_documents" on public.budget_sub_documents for select using (true);
create policy "Users can manage budget_sub_documents" on public.budget_sub_documents for all using (true);

create policy "Users can view actual_invoices" on public.actual_invoices for select using (true);
create policy "Users can manage actual_invoices" on public.actual_invoices for all using (true);

create policy "Users can view shipping_documents" on public.shipping_documents for select using (true);
create policy "Users can manage shipping_documents" on public.shipping_documents for all using (true);

create policy "Users can view inventory_returns" on public.inventory_returns for select using (true);
create policy "Users can manage inventory_returns" on public.inventory_returns for all using (true);

create policy "Users can view order_settlements" on public.order_settlements for select using (true);
create policy "Users can manage order_settlements" on public.order_settlements for all using (true);

-- ============================================================
-- 索引
-- ============================================================
create index if not exists idx_sub_docs_order on public.budget_sub_documents(budget_order_id);
create index if not exists idx_sub_docs_type on public.budget_sub_documents(doc_type);
create index if not exists idx_actual_invoices_order on public.actual_invoices(budget_order_id);
create index if not exists idx_actual_invoices_sub on public.actual_invoices(sub_document_id);
create index if not exists idx_actual_invoices_supplier on public.actual_invoices(supplier_name);
create index if not exists idx_actual_invoices_status on public.actual_invoices(status);
create index if not exists idx_shipping_docs_order on public.shipping_documents(budget_order_id);
create index if not exists idx_inventory_order on public.inventory_returns(budget_order_id);
create index if not exists idx_settlements_order on public.order_settlements(budget_order_id);

-- ============================================================
-- 更新触发器
-- ============================================================
create trigger update_sub_docs_updated_at before update on public.budget_sub_documents for each row execute procedure public.update_updated_at();
create trigger update_invoices_updated_at before update on public.actual_invoices for each row execute procedure public.update_updated_at();
create trigger update_shipping_updated_at before update on public.shipping_documents for each row execute procedure public.update_updated_at();
create trigger update_inventory_updated_at before update on public.inventory_returns for each row execute procedure public.update_updated_at();
create trigger update_settlements_updated_at before update on public.order_settlements for each row execute procedure public.update_updated_at();

-- ============================================================
-- 超预算自动检测函数
-- ============================================================
create or replace function public.check_over_budget()
returns trigger as $$
declare
  budgeted numeric;
begin
  -- 查找对应预算子单据的预算金额
  if new.sub_document_id is not null then
    select estimated_total into budgeted
    from public.budget_sub_documents
    where id = new.sub_document_id;

    if budgeted is not null and new.total_amount > budgeted then
      new.over_budget := true;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger auto_check_over_budget
  before insert or update on public.actual_invoices
  for each row execute procedure public.check_over_budget();
