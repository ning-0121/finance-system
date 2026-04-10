-- ============================================================
-- Document Intelligence Engine — 在Supabase SQL Editor执行
-- ============================================================

-- 1. 文档主表
create table if not exists public.uploaded_documents (
  id uuid primary key default uuid_generate_v4(),
  file_name text not null,
  file_type text not null check (file_type in ('excel','pdf','image','word')),
  file_size integer,
  file_url text,
  doc_category text,
  doc_category_confidence numeric(3,2),
  status text not null default 'pending' check (status in ('pending','extracting','extracted','confirmed','rejected')),
  extracted_fields jsonb not null default '{}'::jsonb,
  matched_order_id uuid,
  matched_customer text,
  matched_supplier text,
  template_id uuid,
  confirmed_by uuid references public.profiles(id),
  confirmed_at timestamptz,
  confirmation_changes jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- 2. 模板记忆表
create table if not exists public.extraction_templates (
  id uuid primary key default uuid_generate_v4(),
  template_name text not null,
  entity_name text not null,
  entity_type text not null check (entity_type in ('customer','supplier','logistics','bank')),
  doc_category text not null,
  column_mapping jsonb not null default '{}'::jsonb,
  field_positions jsonb,
  sample_headers text[],
  usage_count integer not null default 1,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- 3. 文档操作建议表
create table if not exists public.document_actions (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references public.uploaded_documents(id) on delete cascade,
  action_type text not null,
  action_data jsonb not null default '{}'::jsonb,
  status text not null default 'suggested' check (status in ('suggested','confirmed','executed','rejected')),
  executed_by uuid references public.profiles(id),
  executed_at timestamptz,
  created_at timestamptz not null default now()
);

-- RLS
alter table public.uploaded_documents enable row level security;
alter table public.extraction_templates enable row level security;
alter table public.document_actions enable row level security;

create policy "v_docs" on public.uploaded_documents for select using (true);
create policy "m_docs" on public.uploaded_documents for all using (true);
create policy "v_templates" on public.extraction_templates for select using (true);
create policy "m_templates" on public.extraction_templates for all using (true);
create policy "v_doc_actions" on public.document_actions for select using (true);
create policy "m_doc_actions" on public.document_actions for all using (true);

-- 索引
create index if not exists idx_docs_status on public.uploaded_documents(status);
create index if not exists idx_docs_category on public.uploaded_documents(doc_category);
create index if not exists idx_docs_created on public.uploaded_documents(created_at desc);
create index if not exists idx_templates_entity on public.extraction_templates(entity_name, doc_category);
create index if not exists idx_doc_actions_doc on public.document_actions(document_id);
