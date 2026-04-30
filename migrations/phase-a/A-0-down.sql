-- ============================================================
-- Phase A-0 · Safe Foundation — DOWN migration (回滚)
-- ============================================================
-- 一键删除 Phase A-0 创建的所有对象。
-- 不影响任何旧表或现有业务数据。
--
-- 运行方式：
--   Supabase Dashboard → SQL Editor → New Query → 整段粘贴 → Run
--
-- 安全保证：
--   - 仅 drop A-0 新建的 11 个 schema（含其下所有对象）
--   - 不触碰 public schema 的任何对象
--   - 不触碰 auth / storage 等系统 schema
-- ============================================================

-- 提前显式删除触发器和函数（防止 cascade 时漏报）
drop trigger if exists trg_tenants_touch on tenant.tenants;
drop function if exists tenant.touch_updated_at();

-- 删除所有 A-0 schema（cascade 会一并删除其下所有 table / index / function）
drop schema if exists demo            cascade;
drop schema if exists trust           cascade;
drop schema if exists recommendation  cascade;
drop schema if exists benchmark       cascade;
drop schema if exists template        cascade;
drop schema if exists audit           cascade;
drop schema if exists validation      cascade;
drop schema if exists recon           cascade;
drop schema if exists exception       cascade;
drop schema if exists sot             cascade;
drop schema if exists tenant          cascade;

-- ============================================================
-- 回滚完成
-- ============================================================
-- 验证回滚成功（应返回 0 行）：
--   select schema_name from information_schema.schemata
--   where schema_name in
--     ('tenant','sot','exception','recon','validation','audit',
--      'template','benchmark','recommendation','trust','demo');
-- ============================================================
