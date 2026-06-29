-- ============================================================
-- Phase 0a · finance-system · Identity Spine
-- Supabase: qpoboelobqnfbytugzkw（finance，钱的真相）
-- Date: 2026-06-29
-- 设计依据: order-metronome/docs/integration/05-Phase-0-Integration-Spine-Design.md §B.2 / §B.0
-- ------------------------------------------------------------
-- 范围: 仅 finance 4 列（identity spine）。
-- 性质: 纯加法 · 可空 · 幂等(IF NOT EXISTS) · 无跨库 FK · 无索引 ·
--       不改 RLS · 不改 ilike 客户匹配 · 不改 webhook ·
--       不改 budget_orders 现有语义 · 不改 synced_orders.id ·
--       一键回滚 · 不影响线上。
-- 顺序: 三库分开推进，本文件 = 第 2 个(finance)。QIMO(第1)已归档 ffdc602。
-- 边界: 这 4 列在 0a 只“加列”，不接入任何业务/匹配/状态逻辑；
--       启用(用 qimo_*_id 替代 ilike/notes 匹配)是后续 Phase，不在 0a。
-- 回滚约定: finance house style 另有 .down.sql；本文件按 QIMO 同款，
--           回滚 SQL 以注释附在文末（如需可另存 .down.sql）。
-- ============================================================

ALTER TABLE public.customers     ADD COLUMN IF NOT EXISTS qimo_customer_id uuid;  -- 引用 QIMO customers.id
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS qimo_order_id    uuid;  -- 引用 QIMO orders.id
ALTER TABLE public.budget_orders ADD COLUMN IF NOT EXISTS qimo_quote_id    uuid;  -- 引用 QIMO quoter_quotes.id
ALTER TABLE public.synced_orders ADD COLUMN IF NOT EXISTS qimo_quote_id    uuid;  -- 引用 QIMO quoter_quotes.id

-- ---- 列注释（说明引用对象 + 0a 不接业务逻辑 + 非跨库 FK）----
COMMENT ON COLUMN public.customers.qimo_customer_id IS
  'Phase0a identity spine: 引用 QIMO(scrtebex) customers.id（跨库共享企业 id，非 Postgres FK）。'
  '0a 仅加列，不接入业务/匹配/状态逻辑；启用(替代 ilike 客户自建匹配)在后续 Phase。回填见 matching report。';
COMMENT ON COLUMN public.budget_orders.qimo_order_id IS
  'Phase0a identity spine: 引用 QIMO orders.id（跨库共享企业 id，非 Postgres FK）。'
  '0a 仅加列，不改 budget_orders 现有语义、不改 webhook、不改 notes/order_no 匹配；切换在后续 Phase。';
COMMENT ON COLUMN public.budget_orders.qimo_quote_id IS
  'Phase0a identity spine: 引用 QIMO quoter_quotes.id（forecast 报价来源，跨库共享 id，非 FK）。0a 仅加列。';
COMMENT ON COLUMN public.synced_orders.qimo_quote_id IS
  'Phase0a identity spine: 引用 QIMO quoter_quotes.id（随订单内联推送的报价来源，跨库共享 id，非 FK）。'
  '0a 仅加列；synced_orders.id（= QIMO orders.id）语义未改动。';

-- 注: 不加 qimo_supplier_id（延后 Phase 4）；不加任何索引（留 Phase 0e 回填按需）。

-- ============================================================
-- 验证 SQL（数据库门禁 — 在 finance Supabase SQL Editor 单独运行）
-- ------------------------------------------------------------
-- [1][2][3] 4 列存在 + uuid + nullable（期望 4 行，全 uuid / YES）
-- SELECT table_name, column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema='public' AND (
--   (table_name='customers'     AND column_name='qimo_customer_id') OR
--   (table_name='budget_orders' AND column_name IN ('qimo_order_id','qimo_quote_id')) OR
--   (table_name='synced_orders' AND column_name='qimo_quote_id')
-- ) ORDER BY table_name, column_name;
--
-- [4] 4 列 comment 存在（期望 4 行 description；finance qimo_* 为引用 id，无 redline 要求）
-- SELECT c.table_name, c.column_name, pgd.description
-- FROM information_schema.columns c
-- JOIN pg_class st ON st.relname=c.table_name AND st.relnamespace='public'::regnamespace
-- JOIN pg_description pgd ON pgd.objoid=st.oid AND pgd.objsubid=c.ordinal_position
-- WHERE c.table_schema='public' AND (
--   (c.table_name='customers'     AND c.column_name='qimo_customer_id') OR
--   (c.table_name='budget_orders' AND c.column_name IN ('qimo_order_id','qimo_quote_id')) OR
--   (c.table_name='synced_orders' AND c.column_name='qimo_quote_id')
-- ) ORDER BY c.table_name, c.column_name;
--
-- [5] 4 新列上无任何 FK（期望 0 行）
-- SELECT con.conname, t.relname AS tbl, a.attname AS col
-- FROM pg_constraint con
-- JOIN pg_class t ON t.oid=con.conrelid
-- JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(con.conkey)
-- WHERE con.contype='f' AND t.relnamespace='public'::regnamespace
--   AND ( (t.relname='customers'     AND a.attname='qimo_customer_id')
--      OR (t.relname='budget_orders' AND a.attname IN ('qimo_order_id','qimo_quote_id'))
--      OR (t.relname='synced_orders' AND a.attname='qimo_quote_id') );
--
-- [6] 4 新列上无任何索引（期望 0 行）
-- SELECT i.relname AS index_name, t.relname AS tbl, a.attname AS col
-- FROM pg_index ix
-- JOIN pg_class t ON t.oid=ix.indrelid
-- JOIN pg_class i ON i.oid=ix.indexrelid
-- JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(ix.indkey)
-- WHERE t.relnamespace='public'::regnamespace
--   AND ( (t.relname='customers'     AND a.attname='qimo_customer_id')
--      OR (t.relname='budget_orders' AND a.attname IN ('qimo_order_id','qimo_quote_id'))
--      OR (t.relname='synced_orders' AND a.attname='qimo_quote_id') );
--
-- [7] 原有关键列仍在（期望 6 行）
-- SELECT table_name, column_name
-- FROM information_schema.columns
-- WHERE table_schema='public' AND (
--   (table_name='customers'     AND column_name='id') OR
--   (table_name='budget_orders' AND column_name IN ('id','order_no','customer_id')) OR
--   (table_name='synced_orders' AND column_name IN ('id','order_no'))
-- ) ORDER BY table_name, column_name;
--
-- [8] RLS 未被修改（report：三表 rowsecurity + 策略数，对照执行前一致）
-- SELECT c.relname AS tbl, c.relrowsecurity AS rls_enabled,
--        (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname) AS policy_count
-- FROM pg_class c
-- WHERE c.relnamespace='public'::regnamespace
--   AND c.relname IN ('customers','budget_orders','synced_orders')
-- ORDER BY c.relname;
--
-- [9] 新列旧行全 NULL（期望每个 non_null = 0）
-- SELECT 'customers' AS tbl, count(*) AS total, count(qimo_customer_id) AS non_null FROM public.customers
-- UNION ALL
-- SELECT 'budget_orders', count(*), count(qimo_order_id)+count(qimo_quote_id) FROM public.budget_orders
-- UNION ALL
-- SELECT 'synced_orders', count(*), count(qimo_quote_id) FROM public.synced_orders;
--
-- [10] synced_orders.id 未被改动（期望 1 行: id | uuid | is_pk=1）
-- SELECT a.attname, format_type(a.atttypid,a.atttypmod) AS type,
--        (SELECT count(*) FROM pg_constraint con
--           WHERE con.conrelid=t.oid AND con.contype='p' AND a.attnum=ANY(con.conkey)) AS is_pk
-- FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid
-- WHERE t.relname='synced_orders' AND t.relnamespace='public'::regnamespace AND a.attname='id';
-- ============================================================

-- ============================================================
-- 回滚 SQL（如需撤销，单独运行；本文件正常执行不含回滚）
-- ------------------------------------------------------------
-- ALTER TABLE public.customers     DROP COLUMN IF EXISTS qimo_customer_id;
-- ALTER TABLE public.budget_orders DROP COLUMN IF EXISTS qimo_order_id;
-- ALTER TABLE public.budget_orders DROP COLUMN IF EXISTS qimo_quote_id;
-- ALTER TABLE public.synced_orders DROP COLUMN IF EXISTS qimo_quote_id;
-- ============================================================
