-- ============================================================
-- 准确率监控 + 审计日志 — 在Supabase SQL Editor执行
-- ============================================================

create table if not exists public.accuracy_metrics (
  id uuid primary key default uuid_generate_v4(),
  metric_date date not null,
  metric_type text not null check (metric_type in ('classification','extraction','matching','execution','rollback')),
  doc_category text,
  total_count integer not null default 0,
  correct_count integer not null default 0,
  human_modified_count integer not null default 0,
  rejected_count integer not null default 0,
  rollback_count integer not null default 0,
  accuracy_rate numeric(5,2) not null default 0,
  created_at timestamptz not null default now()
);

alter table public.accuracy_metrics enable row level security;
create policy "v_accuracy" on public.accuracy_metrics for select using (true);
create policy "m_accuracy" on public.accuracy_metrics for all using (true);
create index if not exists idx_accuracy_date on public.accuracy_metrics(metric_date, metric_type);
