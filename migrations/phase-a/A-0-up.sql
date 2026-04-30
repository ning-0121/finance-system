-- ============================================================
-- Phase A-0 · Safe Foundation — UP migration
-- ============================================================
-- 目标：仅创建新 schema 骨架 + 默认租户。
-- 严格不动旧表、不触碰旧业务逻辑。
--
-- 运行方式：
--   Supabase Dashboard → SQL Editor → New Query → 整段粘贴 → Run
--
-- 幂等：所有 create / insert 都带 if not exists / on conflict do nothing，
--       可以重复执行无副作用。
--
-- 回滚：A-0-down.sql（一键 drop 所有新建对象）
-- 验证：A-0-verify.sql（验证 11 个 schema + qimo 租户 + 用户映射）
--
-- 影响评估：
--   - 旧表（budget_orders / customers / profit_* 等）：零改动
--   - 旧 RLS / 旧 policy：零改动
--   - 旧业务路径：零影响
-- ============================================================

-- 1. 创建 11 个新 schema（全部为空骨架，不含任何业务表）
-- ============================================================

create schema if not exists tenant;          -- 多租户基础
create schema if not exists sot;             -- Single Source of Truth (字段血缘)
create schema if not exists exception;       -- 异常队列
create schema if not exists recon;           -- Reconciliation Matrix
create schema if not exists validation;     -- 跨字段恒等式
create schema if not exists audit;           -- 字段级审计日志
create schema if not exists template;        -- 行业模板引擎
create schema if not exists benchmark;       -- 行业基准
create schema if not exists recommendation;  -- CFO 建议
create schema if not exists trust;           -- 自动记账可信度
create schema if not exists demo;            -- 演示沙箱

-- 给 schema 加注释（方便 DBA 与未来运维识别）
comment on schema tenant         is 'Phase A-0: 多租户底座 (tenants, tenant_users)';
comment on schema sot            is 'Phase A-1: Single Source of Truth — 字段血缘 (field_lineage)';
comment on schema exception      is 'Phase A-2: 异常队列 (events, routing_rules)';
comment on schema recon          is 'Phase A-3: 自动多方对账 (rules, runs, mismatches)';
comment on schema validation     is 'Phase A-4: 跨字段恒等式 (invariants, violations)';
comment on schema audit          is 'Phase A-1: 全量字段级审计 (events) — append-only';
comment on schema template       is 'Phase C: 行业模板引擎 (industries, bundles)';
comment on schema benchmark      is 'Phase D: 行业基准库 (metrics, observations)';
comment on schema recommendation is 'Phase D: CFO 建议引擎 (suggestions)';
comment on schema trust          is 'Phase B: 自动记账可信度 (field_confidence, posting_decisions)';
comment on schema demo           is 'Phase C: 销售演示沙箱 (scenarios, scripts)';


-- 2. tenant.tenants — 多租户主表
-- ============================================================
create table if not exists tenant.tenants (
  id                    uuid primary key default gen_random_uuid(),
  slug                  text unique not null,                       -- 'qimo' / 'abc-trading'
  display_name          text not null,
  industry_code         text,                                       -- 'garment-export' / 'home-export' / ...
  subscription_tier     text not null default 'internal',           -- 'internal' / 'starter' / 'pro' / 'enterprise'
  seat_count            int  not null default 50,
  agent_call_quota      int  not null default 1000,                 -- AI agent 月调用上限
  api_rate_limit        int  not null default 60,                   -- 请求/分钟
  data_retention_days   int  not null default 365,                  -- 审计日志保留天数
  status                text not null default 'active',             -- 'active' / 'suspended' / 'archived'
  settings              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table tenant.tenants is 'Phase A-0: 多租户主表。当前内部单租户 = qimo';

create index if not exists idx_tenants_slug on tenant.tenants(slug);
create index if not exists idx_tenants_status on tenant.tenants(status);


-- 3. tenant.tenant_users — 用户与租户的映射
-- ============================================================
-- 注意：user_id 不加 FK 到 auth.users（Supabase auth 跨 schema FK 有 RLS 限制），
-- 由应用层保证一致性。一致性靠：
--   - profiles.id 与 auth.users.id 相等（已有约定）
--   - tenant_users.user_id 引用 profiles.id 即可保证有效性
-- ============================================================
create table if not exists tenant.tenant_users (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant.tenants(id) on delete cascade,
  user_id       uuid not null,                                      -- = profiles.id = auth.users.id
  role          text,                                                -- 复用 profiles.role 当前值（admin / finance_manager / ...）
  is_primary    boolean not null default true,                       -- 用户的主租户（用户可属多个，但有且仅一个 primary）
  joined_at     timestamptz not null default now(),
  status        text not null default 'active',                      -- 'active' / 'suspended' / 'left'
  unique (tenant_id, user_id)
);

comment on table tenant.tenant_users is 'Phase A-0: 用户与租户映射。当前所有 profiles 用户 → qimo';

create index if not exists idx_tenant_users_tenant on tenant.tenant_users(tenant_id);
create index if not exists idx_tenant_users_user   on tenant.tenant_users(user_id);
create index if not exists idx_tenant_users_primary on tenant.tenant_users(user_id) where is_primary;


-- 4. 种子：插入默认 qimo 租户（幂等）
-- ============================================================
insert into tenant.tenants (slug, display_name, industry_code, subscription_tier, status)
values ('qimo', '绮陌外贸财务系统', 'garment-export', 'internal', 'active')
on conflict (slug) do nothing;


-- 5. 种子：把现有所有 profiles 用户映射到 qimo 租户（幂等）
-- ============================================================
-- 仅在 profiles 表存在且非空时执行
do $$
declare
  qimo_tenant_id uuid;
  profiles_exists boolean;
begin
  -- 检测 profiles 表是否存在
  select exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'profiles'
  ) into profiles_exists;

  if not profiles_exists then
    raise notice 'profiles 表不存在，跳过用户映射';
    return;
  end if;

  -- 取 qimo 租户 id
  select id into qimo_tenant_id from tenant.tenants where slug = 'qimo';
  if qimo_tenant_id is null then
    raise exception '未找到 qimo 租户，种子失败';
  end if;

  -- 映射用户（幂等：unique(tenant_id, user_id) 阻止重复）
  insert into tenant.tenant_users (tenant_id, user_id, role, is_primary, status)
  select
    qimo_tenant_id,
    p.id,
    p.role,
    true,
    'active'
  from public.profiles p
  on conflict (tenant_id, user_id) do nothing;

  raise notice '已映射 % 个 profiles 用户到 qimo 租户',
    (select count(*) from tenant.tenant_users where tenant_id = qimo_tenant_id);
end $$;


-- 6. 触发器：自动更新 tenants.updated_at
-- ============================================================
create or replace function tenant.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_tenants_touch on tenant.tenants;
create trigger trg_tenants_touch
  before update on tenant.tenants
  for each row execute function tenant.touch_updated_at();


-- ============================================================
-- A-0 完成
-- ============================================================
-- 接下来运行 A-0-verify.sql 进行验证。
-- 如果验证失败，运行 A-0-down.sql 回滚后再排查。
-- ============================================================
