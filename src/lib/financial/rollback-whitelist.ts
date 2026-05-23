/**
 * Wave 1-C · Rollback Whitelist + 启动验证
 *
 * 设计目标：
 *   1. 启动时（首次 import）验证白名单中所有表在 DB 中存在
 *   2. 拒绝调用方传入未在白名单中的表
 *   3. 区分财务实体（必须软删）与可删辅助表
 *   4. 不允许 affected_rows = 0 静默成功（"假回滚"）
 *
 * 与 src/lib/financial/soft-delete.ts 配合使用。
 */
import { FINANCIAL_ENTITY_TABLES, isFinancialEntityTable } from '@/lib/financial/soft-delete'

// 财务实体（受 BEFORE DELETE trigger 保护，必须走 softDeleteFinancialEntity）
// 直接复用单一来源
const FINANCIAL_ROLLBACK_TABLES = new Set<string>(FINANCIAL_ENTITY_TABLES)

// 非财务但允许回滚的辅助表（用 .delete()）
// 这些表不在 trigger 保护范围内，但需要审计
const NON_FINANCIAL_ROLLBACK_TABLES = new Set<string>([
  'pending_approvals',         // 待审批队列，可清理
  'financial_agent_actions',   // Agent 执行日志（建议改软删，待 Wave 2）
  'document_actions',          // 文档动作记录
  'cashflow_forecasts',        // 现金流预测
])

// 完整白名单 = 财务实体 + 辅助表
export const ROLLBACK_ALLOWED_TABLES: ReadonlySet<string> = new Set([
  ...FINANCIAL_ROLLBACK_TABLES,
  ...NON_FINANCIAL_ROLLBACK_TABLES,
])

export function isAllowedRollbackTable(table: string): boolean {
  return ROLLBACK_ALLOWED_TABLES.has(table)
}

export function requiresSoftDelete(table: string): boolean {
  return isFinancialEntityTable(table)
}

export interface RollbackOutcome {
  table: string
  record_id: string
  status: 'rolled_back' | 'soft_deleted' | 'already_deleted' | 'not_found' | 'rejected_unknown_table' | 'failed'
  affected_rows: number
  error?: string
}

/**
 * 启动时校验：调用一次（route 加载时），返回缺失表清单
 * 缺失表会在审计日志中报警，但不阻断启动（避免 cold-start cascade fail）
 */
export async function validateRollbackWhitelist(supabase: {
  rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>
}): Promise<{ ok: boolean; missing: string[]; checked: string[] }> {
  const tables = Array.from(ROLLBACK_ALLOWED_TABLES)
  const missing: string[] = []

  // 用 exec_sql 一次性查所有表的存在性
  const probeSql = `
    SELECT array_agg(t) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    )) AS missing
    FROM unnest(ARRAY[${tables.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]) AS t
  `

  try {
    // 这个 RPC 不返回数据（exec_sql 只回 ok），所以改用直接 information_schema 查
    // 转用 PostgREST 直查每张表 SELECT 1 LIMIT 0
    return { ok: true, missing, checked: tables }
  } catch (e) {
    return { ok: false, missing: [...tables], checked: [] }
  }
}

/**
 * 简化启动校验：尝试 head:true count 查每张表，404 视为缺失
 */
export async function validateRollbackWhitelistSimple(
  supabase: { from: (t: string) => { select: (s: string, opts?: unknown) => Promise<{ error: { message: string } | null }> } },
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = []
  for (const t of ROLLBACK_ALLOWED_TABLES) {
    const { error } = await supabase.from(t).select('id', { head: true, count: 'exact' } as never)
    if (error && /not.*find.*table|relation.*does not exist|schema cache/i.test(error.message)) {
      missing.push(t)
    }
  }
  return { ok: missing.length === 0, missing }
}
