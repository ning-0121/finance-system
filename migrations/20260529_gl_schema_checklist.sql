-- ============================================================
-- GL 底层 schema 检查清单（只读，验收用）
--
-- 用途：在 Supabase SQL Editor 运行，确认生产库已具备 GL 受控灰度所需的全部底层对象。
-- 这是「检查」而非「变更」——不创建/不删除任何东西，可安全重复运行。
--
-- 期望：present 列全部为 true。任何 false 表示该对象缺失，需先补齐再启用灰度过账。
--
-- ⚠️ 不要再把 exec_sql 这类「任意 SQL 执行」函数常驻生产。
--    本检查用标准目录视图即可，无需 exec_sql。
--    验收通过后，建议执行（确认无其他依赖后）：
--        DROP FUNCTION IF EXISTS public.exec_sql(text);
--    以收敛「浏览器/anon 可执行任意 SQL」的攻击面。
-- ============================================================

WITH checks(kind, name) AS (
  VALUES
    ('table',   'accounts'),
    ('table',   'journal_entries'),
    ('table',   'journal_lines'),
    ('table',   'gl_balances'),
    ('table',   'accounting_periods'),
    ('table',   'gl_posting_queue'),
    ('function','create_journal_atomic'),
    ('function','create_journal_draft'),
    ('function','post_journal'),
    ('trigger', 'trg_reverse_gl_on_void')
)
SELECT
  c.kind,
  c.name,
  CASE c.kind
    WHEN 'table'    THEN to_regclass('public.' || c.name) IS NOT NULL
    WHEN 'function' THEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public' AND p.proname = c.name)
    WHEN 'trigger'  THEN EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = c.name)
  END AS present
FROM checks c
ORDER BY c.kind, c.name;

-- 附加：确认 journal_entries 已具备 provenance 列（灰度过账前置）
SELECT 'journal_entries.' || col AS column_check,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema='public' AND table_name='journal_entries' AND column_name=col) AS present
FROM unnest(ARRAY['business_event','source_document_id','posting_queue_id','related_order_id',
                  'related_customer_id','related_supplier_name','exchange_rate_source','explanation',
                  'requires_review','approved_by']) AS col;

-- 附加：确认 exec_sql 是否仍存在（验收后建议 DROP）
SELECT 'exec_sql_still_present' AS check,
       EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='exec_sql') AS present;
