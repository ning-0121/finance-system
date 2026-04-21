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
  if (options?.version) {
    query = query.eq('version', options.version)
  }

  const { data, error } = await query.select().single()

  if (error) {
    const msg = translateError(error.message)
    if (options?.showToast !== false) toast.error(`更新失败: ${msg}`)
    console.error(`[SaveGuard] UPDATE ${table} id=${id} failed:`, error.message)
    return { success: false, error: msg, verified: false }
  }

  if (!data) {
    // 乐观锁冲突：version不匹配
    if (options?.showToast !== false) toast.error('保存冲突：该记录已被其他用户修改，请刷新后重试')
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
 * 财务记录软删除表 — 这些表只标记 deleted_at，不物理删除。
 * 需配合 DB 迁移：ALTER TABLE <table> ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
 * 并在 RLS 中过滤: WHERE deleted_at IS NULL
 *
 * journal_entries 改用 status='voided'（已有该字段），无需 deleted_at。
 */
const SOFT_DELETE_TABLES = new Set([
  'actual_invoices', 'cost_items', 'payable_records',
])

/**
 * 软删除：为财务凭证表设置 deleted_at，其余表硬删除。
 * 作为财务级操作的首选删除方式。
 */
export async function softDelete(
  table: string,
  id: string,
  options?: { showToast?: boolean; deletedBy?: string }
): Promise<SaveResult> {
  const supabase = createClient()

  if (SOFT_DELETE_TABLES.has(table)) {
    // 标记删除时间而非物理删除
    const { error } = await supabase
      .from(table)
      .update({
        deleted_at: new Date().toISOString(),
        ...(options?.deletedBy ? { deleted_by: options.deletedBy } : {}),
      })
      .eq('id', id)
      .is('deleted_at', null) // 幂等：已软删除的不重复标记

    if (error) {
      // 若列不存在则降级硬删除并记录警告
      console.warn(`[SaveGuard] softDelete ${table} id=${id}: deleted_at update failed (${error.message}), 降级硬删除`)
      return safeDelete(table, id, options)
    }

    if (options?.showToast !== false) toast.success('已删除')
    return { success: true, verified: true }
  }

  // 非财务表正常硬删除
  return safeDelete(table, id, options)
}

/**
 * 安全删除：删除后验证确实不存在
 */
export async function safeDelete(
  table: string,
  id: string,
  options?: { showToast?: boolean }
): Promise<SaveResult> {
  const supabase = createClient()

  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) {
    const msg = translateError(error.message)
    if (options?.showToast !== false) toast.error(`删除失败: ${msg}`)
    return { success: false, error: msg, verified: false }
  }

  // 验证确实删除
  const { data: still } = await supabase.from(table).select('id').eq('id', id).single()
  if (still) {
    console.error(`[SaveGuard] DELETE ${table} id=${id} returned success but record still exists`)
    return { success: false, error: '删除未生效', verified: false }
  }

  if (options?.showToast !== false) toast.success('已删除')
  return { success: true, verified: true }
}

/**
 * 诊断日志：记录保存链路每一步的状态
 */
export function logSaveDiagnostic(context: {
  action: string
  table: string
  recordId?: string
  input?: Record<string, unknown>
  dbResult?: unknown
  error?: string
  rlsBlocked?: boolean
}) {
  const timestamp = new Date().toISOString()
  console.log(`[SaveDiag ${timestamp}] ${context.action} ${context.table}`, {
    id: context.recordId,
    error: context.error,
    rlsBlocked: context.rlsBlocked,
    inputKeys: context.input ? Object.keys(context.input) : undefined,
  })
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
