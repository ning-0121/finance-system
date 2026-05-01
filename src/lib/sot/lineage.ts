// ============================================================
// Phase A-1: SoT shadow write — 核心 API
// ============================================================
//
// 三个 API：
//   - sotWriteShadow(params)             写一条字段血缘 + 审计（never throws）
//   - getLineage(table, rowId, field)    读当前来源
//   - getLineageHistory(...)             读完整历史链
//
// 严格不变量：
//   1. sotWriteShadow 的任何错误都不允许抛给调用方
//      （shadow write 失败必须不影响主业务）
//   2. 所有方法是非阻塞副作用（调用方继续正常执行）
//   3. RPC 失败时只 console.warn，不抛
// ============================================================

import { createClient as defaultCreateClient } from '@/lib/supabase/server'
import { getCurrentTenantId as defaultGetCurrentTenantId } from './current-tenant'
import type { SotWriteParams, LineageRow } from './source-types'

// ─── Internal injection points (test-only) ────────────────────────────────
//
// 生产路径直接调用真实实现；测试用 _setTestImplementations 替换。
// 不暴露给外部 — 名字带下划线表示 internal。

type CreateClientFn = typeof defaultCreateClient
type GetTenantIdFn = typeof defaultGetCurrentTenantId

let _createClientImpl: CreateClientFn = defaultCreateClient
let _getTenantIdImpl: GetTenantIdFn = defaultGetCurrentTenantId

/** 测试用：替换 Supabase 客户端工厂与租户 id 获取器 */
export function _setTestImplementations(opts: {
  createClient?: CreateClientFn
  getCurrentTenantId?: GetTenantIdFn
}): void {
  if (opts.createClient) _createClientImpl = opts.createClient
  if (opts.getCurrentTenantId) _getTenantIdImpl = opts.getCurrentTenantId
}

/** 测试用：恢复默认 */
export function _resetTestImplementations(): void {
  _createClientImpl = defaultCreateClient
  _getTenantIdImpl = defaultGetCurrentTenantId
}

// ─── Public API ───────────────────────────────────────────────────────────

/** 写入结果（成功 / 失败都返回，不抛错） */
export interface ShadowWriteResult {
  ok: boolean
  lineageId?: string
  error?: string
}

/**
 * 写一条字段血缘 + 审计事件（原子）。
 *
 * **重要约定**：
 *   - 此函数永远不抛错。失败时返回 { ok: false, error }。
 *   - 调用方不需要 try/catch，但**应当**在主业务保存成功之后再调用，
 *     这样即便此函数失败也不会出现"血缘记录但主数据未保存"的怪状态。
 *
 *     ```ts
 *     // 1. 主业务保存
 *     const { error: saveErr } = await supabase.from('budget_orders')...
 *     if (saveErr) return errorResponse
 *
 *     // 2. shadow write（不影响主流程）
 *     await sotWriteShadow({ ... })
 *     ```
 *
 *   - 调用方甚至可以 fire-and-forget：
 *     `void sotWriteShadow(...)`  // 不 await
 */
export async function sotWriteShadow(params: SotWriteParams): Promise<ShadowWriteResult> {
  try {
    const tenantId = params.tenantId ?? (await _getTenantIdImpl())
    if (!tenantId) {
      return { ok: false, error: 'no tenant id available' }
    }

    const supabase = await _createClientImpl()
    const { data, error } = await supabase
      .schema('sot' as 'public')
      .rpc('shadow_write', {
        p_tenant_id:             tenantId,
        p_target_table:          params.table,
        p_target_row_id:         params.rowId,
        p_target_field:          params.field,
        p_target_field_value:    params.value as never,
        p_source_type:           params.sourceType,
        p_source_entity:         params.sourceEntity ?? null,
        p_source_document_id:    params.sourceDocumentId ?? null,
        p_source_field:          params.sourceField ?? null,
        p_confidence:            typeof params.confidence === 'number' ? params.confidence : 1.0,
        p_verified_by:           params.verifiedBy ?? null,
        p_allow_manual_override: params.allowManualOverride ?? true,
        p_override_reason:       params.overrideReason ?? null,
        p_actor_id:              params.actorId ?? null,
        p_actor_role:            params.actorRole ?? null,
        p_action:                params.action ?? 'sot_shadow_write',
        p_context:               (params.context ?? {}) as never,
        p_ip_address:            null,
        p_user_agent:            null,
      })

    if (error) {
      console.warn(
        `[SoT shadow_write] failed: ${error.message} ` +
        `(table=${params.table} field=${params.field})`
      )
      return { ok: false, error: error.message }
    }

    return { ok: true, lineageId: typeof data === 'string' ? data : undefined }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[SoT shadow_write] threw: ${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * 读当前生效的字段来源。
 * 返回 null 表示无血缘记录或读取失败。
 */
export async function getLineage(
  table: string,
  rowId: string,
  field: string
): Promise<LineageRow | null> {
  try {
    const supabase = await _createClientImpl()
    const { data, error } = await supabase
      .schema('sot' as 'public')
      .from('field_lineage')
      .select('*')
      .eq('target_table', table)
      .eq('target_row_id', rowId)
      .eq('target_field', field)
      .eq('is_current', true)
      .maybeSingle()

    if (error) {
      console.warn(`[SoT getLineage] error: ${error.message}`)
      return null
    }
    return (data as LineageRow) ?? null
  } catch (err) {
    console.warn('[SoT getLineage] threw', err)
    return null
  }
}

/**
 * 读完整历史链（含 superseded 记录），按时间倒序。
 * 可选 field 参数：未提供则返回该 row 的全部字段历史。
 */
export async function getLineageHistory(
  table: string,
  rowId: string,
  field?: string,
  limit = 50
): Promise<LineageRow[]> {
  try {
    const supabase = await _createClientImpl()
    let query = supabase
      .schema('sot' as 'public')
      .from('field_lineage')
      .select('*')
      .eq('target_table', table)
      .eq('target_row_id', rowId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (field) {
      query = query.eq('target_field', field)
    }

    const { data, error } = await query
    if (error) {
      console.warn(`[SoT getLineageHistory] error: ${error.message}`)
      return []
    }
    return (data as LineageRow[]) ?? []
  } catch (err) {
    console.warn('[SoT getLineageHistory] threw', err)
    return []
  }
}

// 重新导出类型，避免外部模块导入两个文件
export type { SotWriteParams, LineageRow, SotSourceType } from './source-types'
export { KEY_FIELDS } from './source-types'
