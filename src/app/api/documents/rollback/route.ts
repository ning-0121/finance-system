// ============================================================
// POST /api/documents/rollback — 回滚已执行的动作
// 按 execution_order 逆序撤销
//
// Wave 1-C 加固（vs 原版）：
//   1. 白名单来源单一化：从 src/lib/financial/rollback-whitelist 导入
//      （移除 ghost tables: receivable_records, payment_records）
//   2. 启动时验证白名单中所有表在 DB 存在（首次 POST 时一次性 lazy check）
//   3. 财务实体强制软删（标记 deleted_at/by/reason），其他表 .delete()
//   4. affected_rows = 0 不再静默成功 → 'already_deleted' 或 'not_found'
//   5. 每个 rollback 步骤都进 financial_agent_actions audit detail
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import {
  ROLLBACK_ALLOWED_TABLES,
  isAllowedRollbackTable,
  requiresSoftDelete,
  validateRollbackWhitelistSimple,
  type RollbackOutcome,
} from '@/lib/financial/rollback-whitelist'

// 启动校验缓存：仅在首次 POST 时跑一次，结果在内存里
let _whitelistValidated: { ok: boolean; missing: string[]; validatedAt: number } | null = null

async function ensureWhitelistValid(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ ok: boolean; missing: string[] }> {
  if (_whitelistValidated) return _whitelistValidated
  const r = await validateRollbackWhitelistSimple(supabase as never)
  _whitelistValidated = { ...r, validatedAt: Date.now() }
  return r
}

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const { document_id, rollback_reason, requested_by } = await request.json()
    if (!document_id) return NextResponse.json({ error: 'Missing document_id' }, { status: 400 })
    if (!rollback_reason || rollback_reason.trim().length < 4) {
      return NextResponse.json({
        error: 'rollback_reason 必须 ≥4 字符（财务回滚必须有可解释原因）',
      }, { status: 400 })
    }

    const supabase = await createClient()

    // ───── 启动校验：白名单中所有表必须真实存在 ─────
    const whitelistCheck = await ensureWhitelistValid(supabase)
    if (!whitelistCheck.ok) {
      // 关键告警：阻断回滚（防止 ghost-table 假回滚 → 财务数据不一致）
      await supabase.from('save_diagnostic_logs').insert({
        action: 'rollback', table_name: '_whitelist', source_page: 'api/documents/rollback',
        status: 'error', actor_id: auth.userId,
        error_detail: `[CRITICAL] rollback 白名单含不存在的表: ${whitelistCheck.missing.join(', ')}`,
      })
      return NextResponse.json({
        error: '回滚白名单含不存在的表，已阻断防止假回滚',
        missing_tables: whitelistCheck.missing,
      }, { status: 500 })
    }

    // ───── 文档校验 ─────
    const { data: doc } = await supabase.from('uploaded_documents').select('doc_category, status').eq('id', document_id).single()
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    if (doc.status !== 'confirmed') return NextResponse.json({ error: 'Document not in confirmed status' }, { status: 400 })

    const { data: agentActions } = await supabase
      .from('financial_agent_actions')
      .select('id, detail')
      .eq('target_type', 'document')
      .eq('target_id', document_id)
      .eq('execution_result', 'success')
      .order('created_at', { ascending: false })
      .limit(1)

    if (!agentActions?.length) {
      return NextResponse.json({ error: 'No execution records found' }, { status: 404 })
    }

    const executionDetail = agentActions[0].detail as Record<string, unknown>
    const results = (executionDetail?.results || []) as { action_type: string; status: string; record_id: string | null; target_table: string }[]
    const successResults = results.filter(r => r.status === 'success' && r.record_id).reverse()

    // ───── 逐项回滚 ─────
    const rollbackResults: Array<RollbackOutcome & { action_type: string }> = []

    for (const action of successResults) {
      const recordId = action.record_id!
      const table = action.target_table

      if (!isAllowedRollbackTable(table)) {
        rollbackResults.push({
          action_type: action.action_type, table, record_id: recordId,
          status: 'rejected_unknown_table', affected_rows: 0,
          error: `表 ${table} 不在白名单 (${Array.from(ROLLBACK_ALLOWED_TABLES).length} 张允许)`,
        })
        continue
      }

      try {
        if (requiresSoftDelete(table)) {
          // ─── 财务实体：软删 (deleted_at + deleted_by + delete_reason) ───
          // .select() 强制返回受影响行，affected_rows = 0 触发 'already_deleted'
          const { data, error } = await supabase
            .from(table)
            .update({
              deleted_at: new Date().toISOString(),
              deleted_by: auth.userId,
              delete_reason: `[rollback] ${rollback_reason}`,
            })
            .eq('id', recordId)
            .is('deleted_at', null)   // 幂等：已软删的不重复
            .select('id')              // 返回受影响行
          if (error) {
            rollbackResults.push({
              action_type: action.action_type, table, record_id: recordId,
              status: 'failed', affected_rows: 0, error: error.message,
            })
          } else if (!data || data.length === 0) {
            // 0 行匹配：要么记录不存在，要么已软删
            const { data: existing } = await supabase.from(table).select('id, deleted_at').eq('id', recordId).maybeSingle()
            rollbackResults.push({
              action_type: action.action_type, table, record_id: recordId,
              status: existing?.deleted_at ? 'already_deleted' : 'not_found',
              affected_rows: 0,
            })
          } else {
            rollbackResults.push({
              action_type: action.action_type, table, record_id: recordId,
              status: 'soft_deleted', affected_rows: data.length,
            })
          }
        } else {
          // ─── 辅助表：硬删但要求 affected_rows > 0 ───
          const { data, error } = await supabase
            .from(table).delete().eq('id', recordId).select('id')
          if (error) {
            rollbackResults.push({
              action_type: action.action_type, table, record_id: recordId,
              status: 'failed', affected_rows: 0, error: error.message,
            })
          } else if (!data || data.length === 0) {
            rollbackResults.push({
              action_type: action.action_type, table, record_id: recordId,
              status: 'not_found', affected_rows: 0,
            })
          } else {
            rollbackResults.push({
              action_type: action.action_type, table, record_id: recordId,
              status: 'rolled_back', affected_rows: data.length,
            })
          }
        }
      } catch (e) {
        rollbackResults.push({
          action_type: action.action_type, table, record_id: recordId,
          status: 'failed', affected_rows: 0,
          error: e instanceof Error ? e.message : 'unknown',
        })
      }
    }

    const rolledBack = rollbackResults.filter(r => r.status === 'rolled_back' || r.status === 'soft_deleted').length
    const failed = rollbackResults.filter(r => r.status === 'failed').length
    const noOp = rollbackResults.filter(r => r.status === 'already_deleted' || r.status === 'not_found').length
    const rejected = rollbackResults.filter(r => r.status === 'rejected_unknown_table').length

    // 更新文档状态（仅当至少有一项成功回滚）
    if (rolledBack > 0) {
      await supabase.from('uploaded_documents').update({ status: 'extracted' }).eq('id', document_id)
      await supabase.from('document_actions').update({ status: 'suggested' }).eq('document_id', document_id)
    }

    // 完整审计
    await supabase.from('financial_agent_actions').insert({
      action_type: 'auto_risk_detection',
      target_type: 'document_rollback',
      target_id: document_id,
      summary: `回滚: ${rolledBack}成功 ${failed}失败 ${noOp}无效 ${rejected}拒绝 | 原因: ${rollback_reason}`,
      detail: {
        rollback_results: rollbackResults,
        rollback_reason,
        requested_by,
        original_execution_id: agentActions[0].id,
        whitelist_validated_at: _whitelistValidated?.validatedAt,
      } as Record<string, unknown>,
      execution_result: failed > 0 ? 'failed' : 'success',
    })

    return NextResponse.json({
      status: failed > 0 ? 'partial_failure' : 'ok',
      rolled_back: rolledBack,
      failed,
      no_op: noOp,
      rejected,
      results: rollbackResults,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Rollback failed' }, { status: 500 })
  }
}
