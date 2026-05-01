-- ============================================================
-- Phase A-1 · SoT Overlay — UP migration
-- ============================================================
-- 目标：建立字段血缘外挂层，旧表不动。
--   - sot.field_lineage：每个关键字段的来源 + 置信度 + 历史
--   - audit.events：append-only 全量审计日志
--   - sot.shadow_write(...) RPC：原子写入（lineage + audit 一次完成）
--
-- 严格不变量：
--   - 一个 (tenant, table, row, field) 同时只能有一行 is_current=true
--   - 写入新行时，旧 current 自动 supersede
--   - 任何写入失败不允许影响主业务（由应用层 try/catch 保证）
--
-- 依赖：A-0（schema tenant / sot / audit 已创建）
-- 回滚：A-1-down.sql
-- 验证：A-1-verify.sql
-- ============================================================


-- 1. sot.field_lineage — 字段血缘表
-- ============================================================
create table if not exists sot.field_lineage (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenant.tenants(id),

  -- 目标定位（旧表里的哪一行的哪一字段）
  target_table             text not null,                       -- 'budget_orders' / 'profit_order_styles' / ...
  target_row_id            uuid not null,
  target_field             text not null,                       -- 'total_revenue' / 'po_number' / ...
  target_field_value       jsonb,                               -- 写入时的值快照（便于事后比对）

  -- 来源
  source_type              text not null,                       -- 见下方 CHECK
  source_entity            text,                                -- 'order_metronome' / 'styles_aggregation' / ...
  source_document_id       uuid,                                -- 原始单据 id（OCR 文件 / 银行流水 / PI ...）
  source_field             text,                                -- 来源单据上的字段

  -- 置信度 + 验证
  confidence               numeric(3,2) not null default 1.00,  -- 0.00 ~ 1.00
  last_verified_at         timestamptz,
  verified_by              uuid,                                -- profiles.id

  -- 人工 override 控制
  allow_manual_override    boolean not null default true,
  override_reason          text,

  -- 审计联动
  audit_event_id           uuid,                                -- → audit.events.id（不加 FK，让 audit 可独立删除）

  -- 版本链
  is_current               boolean not null default true,
  superseded_by            uuid,                                -- → field_lineage.id（不加自引用 FK，简化删除）

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint chk_lineage_source_type check (source_type in (
    'customer_po',
    'quotation',
    'logistics_invoice',
    'bank_statement',
    'supplier_invoice',
    'packing_list',
    'inbound_record',
    'manual_entry',
    'derived',
    'external_system'
  )),
  constraint chk_lineage_confidence check (confidence >= 0 and confidence <= 1)
);

comment on table sot.field_lineage is 'Phase A-1: 关键字段血缘表（外挂式，不改旧表结构）';

-- 唯一性：每 (tenant, table, row, field) 仅一行 is_current
create unique index if not exists uq_field_lineage_current
  on sot.field_lineage (tenant_id, target_table, target_row_id, target_field)
  where is_current;

-- 查询：按目标
create index if not exists idx_field_lineage_target
  on sot.field_lineage (target_table, target_row_id, target_field);

-- 查询：按租户 + 时间
create index if not exists idx_field_lineage_tenant_time
  on sot.field_lineage (tenant_id, created_at desc);

-- 查询：按来源单据反查
create index if not exists idx_field_lineage_source_doc
  on sot.field_lineage (source_document_id) where source_document_id is not null;


-- 2. audit.events — 全量审计日志（append-only）
-- ============================================================
create table if not exists audit.events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant.tenants(id),
  occurred_at     timestamptz not null default now(),

  -- 操作人
  actor_id        uuid,                                          -- profiles.id；null = 系统
  actor_role      text,                                          -- 操作时角色快照（'admin' / 'finance_manager' / ...）

  -- 操作内容
  action          text not null,                                 -- 'sot_shadow_write' / 'manual_override' / 'recompute' / ...
  target_table    text,
  target_row_id   uuid,
  target_field    text,

  -- 数据快照
  before_value    jsonb,
  after_value     jsonb,

  -- 上下文（请求 ip、user_agent、关联实体 id 等）
  context         jsonb not null default '{}'::jsonb,

  ip_address      text,
  user_agent      text
);

comment on table audit.events is 'Phase A-1: 全量字段级审计日志（append-only，不允许 update / delete）';

create index if not exists idx_audit_events_target
  on audit.events (target_table, target_row_id, occurred_at desc);
create index if not exists idx_audit_events_actor
  on audit.events (actor_id, occurred_at desc);
create index if not exists idx_audit_events_tenant
  on audit.events (tenant_id, occurred_at desc);
create index if not exists idx_audit_events_action
  on audit.events (action);


-- 3. append-only 防御：阻止 update / delete audit.events
-- ============================================================
create or replace function audit.prevent_modify()
returns trigger language plpgsql as $$
begin
  raise exception 'audit.events is append-only — UPDATE/DELETE forbidden (action=%)', tg_op;
end $$;

drop trigger if exists trg_audit_no_update on audit.events;
create trigger trg_audit_no_update
  before update on audit.events
  for each row execute function audit.prevent_modify();

drop trigger if exists trg_audit_no_delete on audit.events;
create trigger trg_audit_no_delete
  before delete on audit.events
  for each row execute function audit.prevent_modify();


-- 4. 触发器：自动维护 field_lineage.updated_at
-- ============================================================
create or replace function sot.touch_lineage_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_lineage_touch on sot.field_lineage;
create trigger trg_lineage_touch
  before update on sot.field_lineage
  for each row execute function sot.touch_lineage_updated_at();


-- 5. RPC: sot.shadow_write — 原子写入 audit + lineage
-- ============================================================
-- 一次调用完成：① 写一条 audit.events  ② 把旧 lineage supersede  ③ 写新 lineage
-- 全部失败回滚（隐式事务）。返回新 lineage.id。
--
-- 调用方应用层用 try/catch 包裹本 RPC，shadow write 失败只 log 不抛出。
-- ============================================================
create or replace function sot.shadow_write(
  p_tenant_id              uuid,
  p_target_table           text,
  p_target_row_id          uuid,
  p_target_field           text,
  p_target_field_value     jsonb,
  p_source_type            text,
  p_source_entity          text         default null,
  p_source_document_id     uuid         default null,
  p_source_field           text         default null,
  p_confidence             numeric      default 1.00,
  p_verified_by            uuid         default null,
  p_allow_manual_override  boolean      default true,
  p_override_reason        text         default null,
  p_actor_id               uuid         default null,
  p_actor_role             text         default null,
  p_action                 text         default 'sot_shadow_write',
  p_context                jsonb        default '{}'::jsonb,
  p_ip_address             text         default null,
  p_user_agent             text         default null
) returns uuid
language plpgsql
security definer            -- 允许应用以普通角色调用，函数体仍以 owner 权限读写新 schema
set search_path = sot, audit, tenant, public
as $$
declare
  v_new_id          uuid := gen_random_uuid();
  v_old_id          uuid;
  v_old_value       jsonb;
  v_audit_id        uuid;
begin
  -- 取旧 current（若有）
  select id, target_field_value into v_old_id, v_old_value
  from sot.field_lineage
  where tenant_id = p_tenant_id
    and target_table = p_target_table
    and target_row_id = p_target_row_id
    and target_field = p_target_field
    and is_current;

  -- 写 audit.events
  insert into audit.events (
    tenant_id, actor_id, actor_role, action,
    target_table, target_row_id, target_field,
    before_value, after_value, context, ip_address, user_agent
  ) values (
    p_tenant_id, p_actor_id, p_actor_role, p_action,
    p_target_table, p_target_row_id, p_target_field,
    v_old_value, p_target_field_value, coalesce(p_context, '{}'::jsonb),
    p_ip_address, p_user_agent
  ) returning id into v_audit_id;

  -- supersede 旧 current
  if v_old_id is not null then
    update sot.field_lineage
      set is_current = false,
          superseded_by = v_new_id
      where id = v_old_id;
  end if;

  -- 写新 lineage
  insert into sot.field_lineage (
    id, tenant_id,
    target_table, target_row_id, target_field, target_field_value,
    source_type, source_entity, source_document_id, source_field,
    confidence, last_verified_at, verified_by,
    allow_manual_override, override_reason,
    audit_event_id, is_current
  ) values (
    v_new_id, p_tenant_id,
    p_target_table, p_target_row_id, p_target_field, p_target_field_value,
    p_source_type, p_source_entity, p_source_document_id, p_source_field,
    coalesce(p_confidence, 1.00), now(), p_verified_by,
    coalesce(p_allow_manual_override, true), p_override_reason,
    v_audit_id, true
  );

  return v_new_id;
end $$;

comment on function sot.shadow_write is
  'Phase A-1: 原子写入字段血缘 + 审计事件。失败应被应用层 try/catch 静默处理。';

-- 给 authenticated 角色授权调用本 RPC（service_role 默认有权）
grant execute on function sot.shadow_write to authenticated;


-- ============================================================
-- A-1 完成
-- ============================================================
-- 接下来运行 A-1-verify.sql 验证：
--   1. 表结构与索引齐全
--   2. RPC 可被调用
--   3. 唯一约束生效
--   4. audit append-only 防御生效
-- ============================================================
