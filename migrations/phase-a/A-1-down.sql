-- ============================================================
-- Phase A-1 · SoT Overlay — DOWN migration (回滚)
-- ============================================================
-- 删除 Phase A-1 创建的所有对象。不影响 A-0 的 tenant schema 和数据。
-- ============================================================

-- 1. 删除 RPC
drop function if exists sot.shadow_write(
  uuid, text, uuid, text, jsonb,
  text, text, uuid, text,
  numeric, uuid, boolean, text,
  uuid, text, text,
  jsonb, text, text
);

-- 2. 删除触发器与函数
drop trigger if exists trg_lineage_touch on sot.field_lineage;
drop function if exists sot.touch_lineage_updated_at();

drop trigger if exists trg_audit_no_update on audit.events;
drop trigger if exists trg_audit_no_delete on audit.events;
drop function if exists audit.prevent_modify();

-- 3. 删除表（cascade 处理索引等）
drop table if exists sot.field_lineage cascade;
drop table if exists audit.events cascade;

-- ============================================================
-- 回滚完成
-- ============================================================
-- 验证回滚成功：
--   select to_regclass('sot.field_lineage');   -- 应返回 NULL
--   select to_regclass('audit.events');        -- 应返回 NULL
--   select * from pg_proc where proname = 'shadow_write';  -- 应返回 0 行
-- ============================================================
