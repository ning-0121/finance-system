-- ============================================================
-- Phase A-1 · 验收脚本
-- ============================================================
-- 应用 A-1-up.sql 之后逐条运行。任一项失败立即 down 回滚后排查。
-- ============================================================


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 1：表 sot.field_lineage 结构正确             │
-- │ 预期：返回若干行，包含 13 个核心字段              │
-- └─────────────────────────────────────────────────┘
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'sot' and table_name = 'field_lineage'
order by ordinal_position;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 2：表 audit.events 结构正确                  │
-- └─────────────────────────────────────────────────┘
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'audit' and table_name = 'events'
order by ordinal_position;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 3：唯一约束 + 索引齐全                       │
-- │ 预期：返回至少 5 个索引（lineage 4 + audit 4 = 8）│
-- └─────────────────────────────────────────────────┘
select schemaname, tablename, indexname
from pg_indexes
where schemaname in ('sot', 'audit')
order by schemaname, tablename, indexname;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 4：RPC sot.shadow_write 可调用               │
-- │ 用 qimo 租户写一条测试 lineage                    │
-- └─────────────────────────────────────────────────┘
select sot.shadow_write(
  (select id from tenant.tenants where slug = 'qimo'),  -- p_tenant_id
  'TEST_TABLE',                                          -- p_target_table
  gen_random_uuid(),                                     -- p_target_row_id
  'TEST_FIELD',                                          -- p_target_field
  '"verify-value"'::jsonb,                               -- p_target_field_value
  'manual_entry',                                        -- p_source_type
  'a1-verify-script',                                    -- p_source_entity
  null, null,                                            -- doc_id, source_field
  1.0,                                                   -- confidence
  null, true, null,                                      -- verified_by, allow_override, reason
  null, 'system',                                        -- actor_id, actor_role
  'a1_verify',                                           -- action
  '{"note":"verification test"}'::jsonb,                 -- context
  null, null                                             -- ip, user_agent
) as new_lineage_id;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 5：测试数据已落库                            │
-- │ 预期：1 行 lineage，1 行 audit（同 target）       │
-- └─────────────────────────────────────────────────┘
select fl.id as lineage_id, fl.is_current, fl.target_table, fl.target_field,
       fl.source_type, fl.confidence,
       ae.id as audit_id, ae.action
from sot.field_lineage fl
left join audit.events ae on ae.id = fl.audit_event_id
where fl.target_table = 'TEST_TABLE'
order by fl.created_at desc
limit 1;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 6：append-only 保护生效                      │
-- │ 应抛错：'audit.events is append-only'             │
-- └─────────────────────────────────────────────────┘
do $$
begin
  begin
    update audit.events set action = 'tampered' where action = 'a1_verify';
    raise exception 'append-only 防御失效！能 update audit.events';
  exception
    when others then
      raise notice '✓ audit.events update 已被阻止: %', sqlerrm;
  end;

  begin
    delete from audit.events where action = 'a1_verify';
    raise exception 'append-only 防御失效！能 delete audit.events';
  exception
    when others then
      raise notice '✓ audit.events delete 已被阻止: %', sqlerrm;
  end;
end $$;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 7：唯一 current 约束生效                     │
-- │ 写第二次同 target → 旧的应自动 supersede          │
-- └─────────────────────────────────────────────────┘
-- 取上一步 TEST_TABLE 中那行的 row_id
do $$
declare
  v_tenant_id uuid;
  v_test_row_id uuid;
  v_first_lineage_id uuid;
  v_current_count int;
begin
  select id into v_tenant_id from tenant.tenants where slug = 'qimo';
  select target_row_id into v_test_row_id
    from sot.field_lineage
    where target_table = 'TEST_TABLE' and is_current
    limit 1;

  -- 写第二次（应自动 supersede）
  perform sot.shadow_write(
    v_tenant_id, 'TEST_TABLE', v_test_row_id, 'TEST_FIELD',
    '"verify-value-v2"'::jsonb, 'manual_entry', 'a1-verify-script',
    null, null, 1.0, null, true, null,
    null, 'system', 'a1_verify_supersede',
    '{}'::jsonb, null, null
  );

  -- 应只有 1 行 is_current=true
  select count(*) into v_current_count
  from sot.field_lineage
  where target_table = 'TEST_TABLE'
    and target_row_id = v_test_row_id
    and is_current;

  if v_current_count = 1 then
    raise notice '✓ 唯一 current 约束生效（is_current=true 行数=1）';
  else
    raise exception '唯一 current 约束失效！is_current=true 行数=%', v_current_count;
  end if;
end $$;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 8：旧 current 已被正确 supersede            │
-- │ 应有 1 行 is_current=false 且 superseded_by 非空 │
-- └─────────────────────────────────────────────────┘
select id, is_current, superseded_by, target_field_value
from sot.field_lineage
where target_table = 'TEST_TABLE'
order by created_at;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 9：清理测试数据                              │
-- │ 在普通连接里 audit.events 不能 delete，          │
-- │ 所以用 service_role 或 superuser 执行清理        │
-- └─────────────────────────────────────────────────┘
-- 提示：清理需以 superuser/owner 身份执行。
-- 在 Supabase SQL Editor 默认是 postgres 角色，可以执行。
-- 但生产中由应用调用 RPC 时不应能 delete。
delete from sot.field_lineage where target_table = 'TEST_TABLE';

-- 强制清理 audit（绕过 trigger）
alter table audit.events disable trigger trg_audit_no_delete;
delete from audit.events where action like 'a1_verify%';
alter table audit.events enable trigger trg_audit_no_delete;


-- ┌─────────────────────────────────────────────────┐
-- │ 验证 10：清理后表为空                             │
-- └─────────────────────────────────────────────────┘
select
  (select count(*) from sot.field_lineage where target_table = 'TEST_TABLE') as lineage_test_rows,
  (select count(*) from audit.events where action like 'a1_verify%') as audit_test_rows;
-- 预期：两个都为 0


-- ============================================================
-- 验收完成
-- ============================================================
-- 全部 10 项通过 → A-1 数据库部分部署成功，可以继续 TS 部分
-- 任一项失败 → A-1-down.sql 回滚后排查
-- ============================================================
