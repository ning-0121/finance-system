// 保存可靠性框架 — 财务级写入保护
// 原则：写入后立即验证，绝不假成功
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

interface SaveResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  verified: boolean // 是否经过写后验证
}

/**
 * 安全保存：插入后立即回读验证
 */
export async function safeInsert<T extends Record<string, unknown>>(
  table: string,
  record: Record<string, unknown>,
  options?: { verifyFields?: string[]; showToast?: boolean }
): Promise<SaveResult<T>> {
  const supabase = createClient()

  // 1. 插入
  const { data, error } = await supabase
    .from(table)
    .insert(record)
    .select()
    .single()

  if (error) {
    const msg = translateError(error.message)
    if (options?.showToast !== false) toast.error(`保存失败: ${msg}`)
    console.error(`[SaveGuard] INSERT ${table} failed:`, error.message, record)
    return { success: false, error: msg, verified: false }
  }

  // 2. 写后验证 — 立即回读确认数据存在
  const { data: verifyData, error: verifyErr } = await supabase
    .from(table)
    .select('*')
    .eq('id', data.id)
    .single()

  if (verifyErr || !verifyData) {
    console.error(`[SaveGuard] VERIFY ${table} failed: wrote id=${data.id} but read-back returned empty`)
    if (options?.showToast !== false) toast.error('保存异常：数据已写入但无法回读，请刷新页面')
    return { success: true, data: data as T, error: '写后验证失败', verified: false }
  }

  // 3. 关键字段一致性校验
  if (options?.verifyFields) {
    for (const field of options.verifyFields) {
      if (String(record[field]) !== String(verifyData[field])) {
        console.error(`[SaveGuard] FIELD MISMATCH ${table}.${field}: wrote=${record[field]} read=${verifyData[field]}`)
        return { success: true, data: verifyData as T, error: `字段${field}不一致`, verified: false }
      }
    }
  }

  if (options?.showToast !== false) toast.success('已保存')
  return { success: true, data: verifyData as T, verified: true }
}

/**
 * 安全更新：更新后立即回读验证
 */
export async function safeUpdate<T extends Record<string, unknown>>(
  table: string,
  id: string,
  updates: Record<string, unknown>,
  options?: { version?: number; verifyFields?: string[]; showToast?: boolean }
): Promise<SaveResult<T>> {
  const supabase = createClient()

  // 1. 构建查询（带乐观锁）
  let query = supabase.from(table).update(updates).eq('id', id)
  if (options?.version !== undefined) {
    query = query.eq('version', options.version)
  }

  // 使用 maybeSingle() 区分"0行匹配（锁冲突）"和"真实DB错误"
  const { data, error } = await query.select().maybeSingle()

  if (error) {
    const msg = translateError(error.message)
    if (options?.showToast !== false) toast.error(`更新失败: ${msg}`)
    console.error(`[SaveGuard] UPDATE ${table} id=${id} failed:`, error.message)
    return { success: false, error: msg, verified: false }
  }

  if (!data) {
    // 乐观锁冲突：version 不匹配，Supabase 返回 0 行
    const conflictMsg = options?.version !== undefined
      ? '保存冲突：该记录已被其他用户修改，请刷新后重试'
      : '记录不存在或已被删除'
    if (options?.showToast !== false) toast.error(conflictMsg)
    console.warn(`[SaveGuard] UPDATE ${table} id=${id}: 0 rows matched (version=${options?.version ?? 'N/A'})`)
    return { success: false, error: '乐观锁冲突', verified: false }
  }

  // 2. 写后验证
  const { data: verifyData } = await supabase.from(table).select('*').eq('id', id).single()

  if (!verifyData) {
    console.error(`[SaveGuard] VERIFY ${table} id=${id} failed: update succeeded but read-back empty`)
    return { success: true, data: data as T, error: '写后验证失败', verified: false }
  }

  if (options?.showToast !== false) toast.success('已保存')
  return { success: true, data: verifyData as T, verified: true }
}

/**
 * Wave 1-A · 财务实体软删除受保护清单。
 *
 * 与 src/lib/financial/soft-delete.ts 中的 FINANCIAL_ENTITY_TABLES 保持一致；
 * DB 层 BEFORE DELETE trigger（financial_hard_delete_guard）作为底线兜底。
 *
 * 财务实体的删除必须走 softDeleteFinancialEntity()（强制 actor+reason），
 * 本文件不再提供针对财务表的"便利"硬删除路径——任何"fallback 到硬删除"
 * 被视为 P0 architecture violation。
 */
import {
  FINANCIAL_ENTITY_TABLES,
  isFinancialEntityTable,
  softDeleteFinancialEntity,
} from '@/lib/financial/soft-delete'

const SOFT_DELETE_TABLES = new Set<string>(FINANCIAL_ENTITY_TABLES)

/**
 * 软删除：财务实体走 softDeleteFinancialEntity（强制 actor+reason）；
 * 非财务表走 safeDelete 物理删除。
 *
 * 注意：传入财务表但未提供 deletedBy/reason 会直接报错——这是有意的，
 * 软删除必须可追溯，UI 必须强制弹窗收集 reason。
 */
export async function softDelete(
  table: string,
  id: string,
  options?: { showToast?: boolean; deletedBy?: string; reason?: string; sourcePage?: string }
): Promise<SaveResult> {
  if (SOFT_DELETE_TABLES.has(table) && isFinancialEntityTable(table)) {
    if (!options?.deletedBy) {
      const msg = '财务实体删除必须提供 deletedBy（actor UUID）'
      if (options?.showToast !== false) toast.error(msg)
      return { success: false, error: msg, verified: false }
    }
    if (!options?.reason || options.reason.trim().length < 4) {
      const msg = '财务实体删除必须提供原因（不少于 4 字符）'
      if (options?.showToast !== false) toast.error(msg)
      return { success: false, error: msg, verified: false }
    }
    const result = await softDeleteFinancialEntity({
      table,
      id,
      actorId: options.deletedBy,
      reason: options.reason,
      sourcePage: options.sourcePage,
    })
    if (!result.ok) {
      if (options?.showToast !== false) toast.error(`删除失败: ${result.error}`)
      return { success: false, error: result.error ?? '未知错误', verified: false }
    }
    if (options?.showToast !== false) {
      toast.success(result.alreadyDeleted ? '该记录已于早前删除' : '已删除')
    }
    return { success: true, verified: true }
  }

  // 非财务表才允许硬删除
  return safeDelete(table, id, options)
}

/**
 * 安全删除（非财务表专用）。如果误传财务表，立刻 hard fail。
 *
 * Wave 1-A 之前的"silently fallback to hard delete"路径已彻底移除。
 */
export async function safeDelete(
  table: string,
  id: string,
  options?: { showToast?: boolean }
): Promise<SaveResult> {
  // 财务表禁止走硬删除路径——任何调用方误传都视为 P0 阻断
  if (SOFT_DELETE_TABLES.has(table)) {
    const msg = `safeDelete 拒绝执行：表 "${table}" 是受保护财务实体，请使用 softDeleteFinancialEntity()`
    console.error('[SaveGuard]', msg)
    if (options?.showToast !== false) toast.error(msg)
    return { success: false, error: msg, verified: false }
  }

  const supabase = createClient()

  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) {
    const msg = translateError(error.message)
    if (options?.showToast !== false) toast.error(`删除失败: ${msg}`)
    return { success: false, error: msg, verified: false }
  }

  // 验证确实删除
  const { data: still } = await supabase.from(table).select('id').eq('id', id).maybeSingle()
  if (still) {
    const msg = `DELETE ${table} id=${id} returned success but record still exists`
    console.error(`[SaveGuard] ${msg}`)
    if (options?.showToast !== false) toast.error('删除未生效')
    return { success: false, error: '删除未生效', verified: false }
  }

  if (options?.showToast !== false) toast.success('已删除')
  return { success: true, verified: true }
}

/**
 * 诊断日志：记录保存链路每一步的状态（持久化到 save_diagnostic_logs 表）
 * 支持追踪"前端看到成功但数据没了"、"哪一步把数据覆盖了"等场景。
 */
export async function logSaveDiagnostic(context: {
  action: string
  table: string
  recordId?: string
  actorId?: string
  sourcePage?: string
  apiRoute?: string
  payloadHash?: string
  dbHash?: string
  input?: Record<string, unknown>
  dbResult?: unknown
  error?: string
  rlsBlocked?: boolean
}): Promise<void> {
  const timestamp = new Date().toISOString()

  // 确定状态
  let status: 'ok' | 'mismatch' | 'rls_blocked' | 'not_found' | 'error' = 'ok'
  if (context.rlsBlocked) status = 'rls_blocked'
  else if (context.error?.includes('not_found') || context.error?.includes('0 rows')) status = 'not_found'
  else if (context.payloadHash && context.dbHash && context.payloadHash !== context.dbHash) status = 'mismatch'
  else if (context.error) status = 'error'

  // console 仍保留（方便本地调试）
  console.log(`[SaveDiag ${timestamp}] ${context.action} ${context.table}`, {
    id: context.recordId,
    status,
    error: context.error,
    rlsBlocked: context.rlsBlocked,
    inputKeys: context.input ? Object.keys(context.input) : undefined,
  })

  // 持久化写入（fire-and-forget，不阻塞主流程）
  try {
    const supabase = createClient()
    await supabase.from('save_diagnostic_logs').insert({
      action:       context.action,
      table_name:   context.table,
      record_id:    context.recordId ?? null,
      actor_id:     context.actorId ?? null,
      source_page:  context.sourcePage ?? null,
      api_route:    context.apiRoute ?? null,
      payload_hash: context.payloadHash ?? null,
      db_hash:      context.dbHash ?? null,
      status,
      error_detail: context.error ?? null,
    })
  } catch (diagErr) {
    // 诊断写入失败不能影响主业务流程
    console.error('[SaveDiag] 持久化写入失败:', diagErr)
  }
}

/**
 * 翻译Supabase错误为中文
 */
function translateError(msg: string): string {
  if (msg.includes('violates foreign key')) return '关联记录不存在（外键约束）'
  if (msg.includes('violates check constraint')) {
    if (msg.includes('non_negative') || msg.includes('positive')) return '金额不能为负数'
    if (msg.includes('exchange_rate')) return '汇率必须大于0'
    if (msg.includes('currency_valid')) return '不支持的币种'
    if (msg.includes('balanced')) return '借贷不平衡'
    return '数据校验失败'
  }
  if (msg.includes('violates unique')) return '数据已存在（重复）'
  if (msg.includes('not-null')) return '必填字段为空'
  if (msg.includes('已审批')) return '已审批的订单不能修改金额'
  if (msg.includes('不能审批自己')) return '不能审批自己创建的订单'
  if (msg.includes('非法状态转换')) return msg
  if (msg.includes('已关闭')) return msg
  if (msg.includes('已过账')) return msg
  return msg
}
