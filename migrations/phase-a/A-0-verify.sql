-- ============================================================
-- Phase A-0 · 验收脚本
-- ============================================================
-- 运行 A-0-up.sql 之后执行本脚本，逐条核对结果。
-- 每一条 SELECT 都附预期结果，发现不符立即停止并 rollback。
--
-- 运行方式：
--   一条一条贴到 Supabase SQL Editor 中独立执行。
-- ============================================================


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 1：11 个新 schema 已创建                     │
-- │ 预期：返回 11 行                                  │
-- └─────────────────────────────────────────────────┘
select schema_name
from information_schema.schemata
where schema_name in (
  'tenant','sot','exception','recon','validation','audit',
  'template','benchmark','recommendation','trust','demo'
)
order by schema_name;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 2：tenant.tenants 中存在且仅存在 qimo 租户   │
-- │ 预期：返回 1 行，slug=qimo, status=active        │
-- └─────────────────────────────────────────────────┘
select id, slug, display_name, industry_code, subscription_tier, status, seat_count
from tenant.tenants;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 3：所有 profiles 用户都已映射到 qimo         │
-- │ 预期：tenant_user_count = profiles_count         │
-- └─────────────────────────────────────────────────┘
select
  (select count(*) from tenant.tenant_users) as tenant_user_count,
  (select count(*) from public.profiles)     as profiles_count,
  case
    when (select count(*) from tenant.tenant_users) = (select count(*) from public.profiles)
      then 'OK'
    else 'MISMATCH — 检查 profiles 是否有重复 id 或种子是否成功'
  end as status;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 4：除 tenant 外，其他 10 个新 schema 为空    │
-- │ 预期：返回 0 行（没有任何 table）                  │
-- └─────────────────────────────────────────────────┘
select table_schema, table_name
from information_schema.tables
where table_schema in (
  'sot','exception','recon','validation','audit',
  'template','benchmark','recommendation','trust','demo'
)
order by table_schema, table_name;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 5：旧表完全未被改动 — 抽查 3 张关键表        │
-- │ 预期：行数与 A-0 执行前完全一致                   │
-- └─────────────────────────────────────────────────┘
select
  (select count(*) from public.budget_orders)         as budget_orders_count,
  (select count(*) from public.customers)             as customers_count,
  (select count(*) from public.profit_order_styles)   as profit_styles_count;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 6：tenant_users 中每个用户恰有一个 primary   │
-- │ 预期：返回 0 行（没有重复 primary）                │
-- └─────────────────────────────────────────────────┘
select user_id, count(*) as primary_count
from tenant.tenant_users
where is_primary
group by user_id
having count(*) > 1;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 7：触发器生效（updated_at 会自动跳）         │
-- │ 操作：执行 update 后查 updated_at 应大于 created_at │
-- └─────────────────────────────────────────────────┘
update tenant.tenants
  set settings = settings || jsonb_build_object('verify_test', true)
  where slug = 'qimo';

select slug, created_at, updated_at,
  case when updated_at > created_at then 'OK' else 'TRIGGER NOT WORKING' end as status
from tenant.tenants where slug = 'qimo';

-- 清理验证用的字段
update tenant.tenants
  set settings = settings - 'verify_test'
  where slug = 'qimo';


-- ============================================================
-- 验收完成
-- ============================================================
-- 所有 7 项验证通过 → A-0 部署成功
-- 任何一项失败 → 立即执行 A-0-down.sql 回滚后排查原因
-- ============================================================
