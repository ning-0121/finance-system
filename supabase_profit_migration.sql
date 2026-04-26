-- ============================================================
-- Profit Control Center — Database Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================================

-- 1. profit_order_styles: 每个订单下每个款式的详细成本拆分
create table if not exists profit_order_styles (
  id uuid default gen_random_uuid() primary key,
  budget_order_id uuid references budget_orders(id) on delete cascade not null,
  style_no text not null,
  product_category text,               -- leggings / sports bra / hoodie / t-shirt ...
  size_type text default 'missy',      -- junior / missy / plus
  qty integer default 0,

  -- 销售价格
  selling_price_per_piece_usd numeric(10,4) default 0,

  -- 面料成本
  fabric_usage_kg_per_piece numeric(8,4) default 0,
  fabric_price_per_kg_rmb numeric(10,2) default 0,

  -- 加工费 CMT (RMB/件)
  cmt_cost_per_piece_rmb numeric(10,2) default 0,

  -- 辅料 + 包装 (RMB/件)
  trim_cost_per_piece_rmb numeric(10,2) default 0,
  packing_cost_per_piece_rmb numeric(10,2) default 0,

  -- 物流 (USD/件)
  freight_cost_per_piece_usd numeric(10,4) default 0,

  -- 其他成本 (RMB/件)
  other_cost_per_piece_rmb numeric(10,2) default 0,

  -- 汇率（继承自订单，可单独覆盖）
  exchange_rate numeric(10,4) default 7,

  -- 备注
  notes text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_profit_order_styles_order on profit_order_styles(budget_order_id);
create index if not exists idx_profit_order_styles_category on profit_order_styles(product_category);

-- 2. profit_cost_benchmarks: 各品类目标成本基准
create table if not exists profit_cost_benchmarks (
  id uuid default gen_random_uuid() primary key,
  product_category text not null,
  size_type text not null default 'missy',
  target_fabric_usage_kg numeric(8,4),
  target_fabric_price_per_kg_rmb numeric(10,2),
  target_cmt_cost_rmb numeric(10,2),
  target_trim_cost_rmb numeric(10,2),
  target_packing_cost_rmb numeric(10,2),
  target_margin numeric(5,2) default 15,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(product_category, size_type)
);

-- 3. 预置行业基准数据（可在系统内编辑覆盖）
insert into profit_cost_benchmarks
  (product_category, size_type, target_fabric_usage_kg, target_fabric_price_per_kg_rmb, target_cmt_cost_rmb, target_trim_cost_rmb, target_packing_cost_rmb, target_margin)
values
  ('leggings',      'junior', 0.18, 38, 12, 3, 2, 18),
  ('leggings',      'missy',  0.22, 38, 14, 3, 2, 18),
  ('leggings',      'plus',   0.28, 38, 16, 3, 2, 15),
  ('flare leggings','missy',  0.24, 38, 15, 3, 2, 17),
  ('biker shorts',  'missy',  0.16, 36, 10, 3, 2, 18),
  ('sports bra',    'junior', 0.10, 42, 10, 4, 2, 18),
  ('sports bra',    'missy',  0.12, 42, 12, 4, 2, 18),
  ('hoodie',        'missy',  0.45, 35, 22, 5, 3, 15),
  ('hoodie',        'plus',   0.55, 35, 25, 5, 3, 12),
  ('jacket',        'missy',  0.50, 45, 28, 8, 3, 15),
  ('t-shirt',       'missy',  0.20, 28,  8, 2, 2, 18),
  ('shorts',        'missy',  0.18, 32, 10, 3, 2, 18),
  ('skort',         'missy',  0.22, 34, 12, 3, 2, 17),
  ('jogger',        'missy',  0.30, 30, 14, 4, 2, 16),
  ('fleece set',    'missy',  0.80, 32, 35, 6, 4, 12),
  ('plus size set', 'plus',   0.90, 32, 38, 6, 4, 11)
on conflict (product_category, size_type) do nothing;

-- 4. RLS Policies (profit module — finance & admin read/write, sales read-own)
alter table profit_order_styles enable row level security;
alter table profit_cost_benchmarks enable row level security;

-- 允许已认证用户读取（前端通过server-side API访问，RLS作为双重保障）
create policy "profit_styles_select" on profit_order_styles for select using (auth.role() = 'authenticated');
create policy "profit_styles_insert" on profit_order_styles for insert with check (auth.role() = 'authenticated');
create policy "profit_styles_update" on profit_order_styles for update using (auth.role() = 'authenticated');
create policy "profit_styles_delete" on profit_order_styles for delete using (auth.role() = 'authenticated');

create policy "benchmarks_select" on profit_cost_benchmarks for select using (auth.role() = 'authenticated');
create policy "benchmarks_all" on profit_cost_benchmarks for all using (auth.role() = 'authenticated');
