// ============================================================
// POST /api/documents/rollback — 回滚已执行的动作
// 按execution_order逆序撤销，L3/L4回滚需审批
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  try {
    const { document_id, rollback_reason, requested_by } = await request.json()
    if (!document_id) return NextResponse.json({ error: 'Missing document_id' }, { status: 400 })

    const supabase = await createClient()

    // 获取该文档的所有已执行动作
    const { data: doc } = await supabase.from('uploaded_documents').select('doc_category, status').eq('id', document_id).single()
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    if (doc.status !== 'confirmed') return NextResponse.json({ error: 'Document not in confirmed status' }, { status: 400 })

    // 获取执行日志
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

    // 逆序回滚已成功的动作
    const rollbackResults: { action_type: string; status: string; error: string | null }[] = []
    const successResults = results.filter(r => r.status === 'success' && r.record_id).reverse()

    for (const action of successResults) {
      try {
        if (action.record_id) {
          // 通用回滚：删除创建的记录
          const { error } = await supabase
            .from(action.target_table)
            .delete()
            .eq('id', action.record_id)

          rollbackResults.push({
            action_type: action.action_type,
            status: error ? 'failed' : 'rolled_back',
            error: error?.message || null,
          })
        }
      } catch (e) {
        rollbackResults.push({
          action_type: action.action_type,
          status: 'failed',
          error: e instanceof Error ? e.message : 'Rollback failed',
        })
      }
    }

    const rolledBack = rollbackResults.filter(r => r.status === 'rolled_back').length
    const failed = rollbackResults.filter(r => r.status === 'failed').length

    // 更新文档状态
    await supabase.from('uploaded_documents').update({ status: 'extracted' }).eq('id', document_id)

    // 更新document_actions状态
    await supabase.from('document_actions').update({ status: 'suggested' }).eq('document_id', document_id)

    // 记录回滚审计日志
    await supabase.from('financial_agent_actions').insert({
      action_type: 'auto_risk_detection',
      target_type: 'document_rollback',
      target_id: document_id,
      summary: `回滚: ${rolledBack}成功 ${failed}失败 | 原因: ${rollback_reason || '未说明'}`,
      detail: {
        rollback_results: rollbackResults,
        rollback_reason,
        requested_by,
        original_execution_id: agentActions[0].id,
      } as Record<string, unknown>,
      execution_result: failed > 0 ? 'failed' : 'success',
    })

    return NextResponse.json({
      status: 'ok',
      rolled_back: rolledBack,
      failed,
      results: rollbackResults,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Rollback failed' }, { status: 500 })
  }
}
