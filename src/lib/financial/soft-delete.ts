/**
 * Wave 1-A · Unified Soft Delete Service for Financial Entities
 *
 * 财务实体禁止物理删除。所有"删除"必须通过本服务标记 deleted_at/by/reason，
 * 并写一行 save_diagnostic_logs 作为审计痕迹。
 *
 * DB 层有 BEFORE DELETE trigger（financial_hard_delete_guard）兜底拦截绕过
 * 本 service 的硬删除尝试；故本 service 主要负责：
 *   1. 业务规则（actor / reason 强制）
 *   2. 写入 audit log
 *   3. 友好错误
 *   4. 检验幂等
 *
 * 公开 API：
 *   - softDeleteFinancialEntity({ table, id, actorId, reason }) → 业务/UI 入口
 *   - assertFinancialEntity(table) → 类型守卫
 *   - FINANCIAL_ENTITY_TABLES → 受保护表清单
 */
import { createClient } from '@/lib/supabase/client'

export const FINANCIAL_ENTITY_TABLES = [
  'actual_invoices',
  'payable_records',
  'order_settlements',
  'budget_orders',
  'shipping_documents',
  'financial_risk_events',
  'cost_items',
  'journal_entries',
  'journal_lines',
] as const

export type FinancialEntityTable = (typeof FINANCIAL_ENTITY_TABLES)[number]

export function isFinancialEntityTable(table: string): table is FinancialEntityTable {
  return (FINANCIAL_ENTITY_TABLES as readonly string[]).includes(table)
}

export function assertFinancialEntity(table: string): asserts table is FinancialEntityTable {
  if (!isFinancialEntityTable(table)) {
    throw new Error(
      `[soft-delete] 表 "${table}" 不是受保护的财务实体。如需软删除请先纳入 FINANCIAL_ENTITY_TABLES。`,
    )
  }
}

export interface SoftDeleteResult {
  ok: boolean
  alreadyDeleted: boolean
  table: FinancialEntityTable
  id: string
  deletedAt: string | null
  error: string | null
}

export interface SoftDeleteParams {
  table: FinancialEntityTable
  id: string
  actorId: string         // 强制：执行删除的用户 id（auth.users.id）
  reason: string          // 强制：业务原因（至少 4 字符）
  sourcePage?: string     // 可选：发起页面，写入 audit
}

/**
 * 财务实体软删除（统一入口）
 *
 * 规则：
 *   - actor 必填（UUID 格式）
 *   - reason 必填且 ≥ 4 字符
 *   - 已软删除的记录返回 { ok: true, alreadyDeleted: true }（幂等）
 *   - 任何 DB 错误返回 { ok: false, error }，不抛异常（UI 层决定如何提示）
 *   - 永远写一行 save_diagnostic_logs（即使失败）
 */
export async function softDeleteFinancialEntity(
  params: SoftDeleteParams,
): Promise<SoftDeleteResult> {
  const { table, id, actorId, reason, sourcePage } = params
  assertFinancialEntity(table)

  // 业务规则校验
  if (!id || typeof id !== 'string') {
    return { ok: false, alreadyDeleted: false, table, id, deletedAt: null, error: 'id 不能为空' }
  }
  if (!actorId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actorId)) {
    return { ok: false, alreadyDeleted: false, table, id, deletedAt: null, error: 'actorId 必须是有效 UUID' }
  }
  if (!reason || reason.trim().length < 4) {
    return { ok: false, alreadyDeleted: false, table, id, deletedAt: null, error: '删除原因不能少于 4 个字符' }
  }

  const supabase = createClient()

  // 1. 读取当前状态（判断幂等）
  const { data: current, error: readErr } = await supabase
    .from(table)
    .select('id, deleted_at')
    .eq('id', id)
    .maybeSingle()

  if (readErr) {
    await writeAudit({ table, id, actorId, sourcePage, status: 'error', detail: `read failed: ${readErr.message}` })
    return { ok: false, alreadyDeleted: false, table, id, deletedAt: null, error: readErr.message }
  }
  if (!current) {
    await writeAudit({ table, id, actorId, sourcePage, status: 'not_found', detail: '记录不存在' })
    return { ok: false, alreadyDeleted: false, table, id, deletedAt: null, error: '记录不存在' }
  }
  if (current.deleted_at) {
    // 幂等：已删除
    return {
      ok: true,
      alreadyDeleted: true,
      table,
      id,
      deletedAt: current.deleted_at as string,
      error: null,
    }
  }

  // 2. 软删除
  const nowIso = new Date().toISOString()
  const { error: updErr } = await supabase
    .from(table)
    .update({ deleted_at: nowIso, deleted_by: actorId, delete_reason: reason.trim() })
    .eq('id', id)
    .is('deleted_at', null) // race 防护：只更新未被删除的记录

  if (updErr) {
    await writeAudit({ table, id, actorId, sourcePage, status: 'error', detail: `update failed: ${updErr.message}` })
    return { ok: false, alreadyDeleted: false, table, id, deletedAt: null, error: updErr.message }
  }

  // 3. 写后回读验证
  const { data: verify } = await supabase
    .from(table)
    .select('deleted_at, delete_reason, deleted_by')
    .eq('id', id)
    .maybeSingle()
  if (!verify?.deleted_at) {
    await writeAudit({ table, id, actorId, sourcePage, status: 'verify_failed', detail: '写入后回读未发现 deleted_at' })
    return { ok: false, alreadyDeleted: false, table, id, deletedAt: null, error: '写后验证失败：deleted_at 未生效' }
  }

  // 4. 写 audit log
  await writeAudit({ table, id, actorId, sourcePage, status: 'ok', detail: reason.trim() })

  return { ok: true, alreadyDeleted: false, table, id, deletedAt: verify.deleted_at as string, error: null }
}

/**
 * 拒绝硬删除的兜底守卫（用于 src/lib/save-guard.ts 内部）。
 * 当 safeDelete 被调用并发现 table 是财务实体时，应抛出此错误。
 */
export class HardDeleteForbiddenError extends Error {
  constructor(table: string, id: string) {
    super(`HARD_DELETE_FORBIDDEN: 表 ${table} 是受保护财务实体，禁止物理删除（id=${id}）`)
    this.name = 'HardDeleteForbiddenError'
  }
}

// ─── 内部：写诊断日志 ─────────────────────────────────────
async function writeAudit(opts: {
  table: string
  id: string
  actorId: string
  sourcePage?: string
  status: 'ok' | 'error' | 'not_found' | 'verify_failed'
  detail: string
}) {
  try {
    const supabase = createClient()
    await supabase.from('save_diagnostic_logs').insert({
      action: 'soft_delete',
      table_name: opts.table,
      record_id: opts.id,
      actor_id: opts.actorId,
      source_page: opts.sourcePage ?? null,
      status: opts.status,
      error_detail: opts.status === 'ok' ? null : opts.detail,
      payload_hash: null,
      db_hash: null,
    })
  } catch (e) {
    // audit log 写入失败本身需要警示，但不能阻塞主流程
    console.error('[soft-delete] audit log 写入失败:', e)
  }
}
