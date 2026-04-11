// ============================================================
// POST /api/documents/execute — 动作级执行
// 接收 approved_actions: 只执行用户accept的动作
// rejected_actions: 记录用户reject的动作(用于准确率反馈)
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { executeDocumentActions } from '@/lib/document-engine/executor'
import type { DocCategory } from '@/lib/types/document'

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const {
      document_id,
      confirmed_fields,
      confirmed_by,
      approved_actions,   // string[] — 只执行这些action_type
      rejected_actions,   // string[] — 被reject的action_type(记录反馈)
    } = await request.json()

    if (!document_id) {
      return NextResponse.json({ error: 'Missing document_id' }, { status: 400 })
    }

    const supabase = await createClient()

    const { data: doc } = await supabase
      .from('uploaded_documents')
      .select('doc_category, status, extracted_fields')
      .eq('id', document_id)
      .single()

    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    if (doc.status === 'confirmed') return NextResponse.json({ error: 'Already confirmed' }, { status: 400 })

    // 记录被reject的动作到准确率反馈
    if (rejected_actions?.length) {
      const feedbackEvents = rejected_actions.map((actionType: string) => ({
        document_id,
        event_type: 'action_rejected',
        action_type: actionType,
        doc_category: doc.doc_category,
        entity_name: (doc.extracted_fields?.customer_name || doc.extracted_fields?.supplier_name || '') as string,
      }))
      await supabase.from('accuracy_feedback_events').insert(feedbackEvents)    }

    // 记录被修改的字段到准确率反馈
    if (confirmed_fields && doc.extracted_fields) {
      const original = doc.extracted_fields as Record<string, unknown>
      const confirmed = confirmed_fields as Record<string, unknown>
      const corrections = Object.keys(confirmed)
        .filter(k => !k.startsWith('_') && JSON.stringify(original[k]) !== JSON.stringify(confirmed[k]) && original[k] !== undefined)
        .map(k => ({
          document_id,
          event_type: 'field_corrected' as const,
          field_name: k,
          original_value: String(original[k] ?? ''),
          corrected_value: String(confirmed[k] ?? ''),
          doc_category: doc.doc_category,
          entity_name: String(confirmed.customer_name || confirmed.supplier_name || ''),
        }))

      if (corrections.length > 0) {
        await supabase.from('accuracy_feedback_events').insert(corrections)      }
    }

    // 更新document_actions的decision状态
    if (approved_actions?.length) {
      const { error: approveErr } = await supabase.from('document_actions')
        .update({ decision: 'accepted', decided_by: confirmed_by, decided_at: new Date().toISOString() })
        .eq('document_id', document_id)
        .in('action_type', approved_actions)
      if (approveErr) console.error('动作审批状态更新失败:', approveErr.message)
    }
    if (rejected_actions?.length) {
      const { error: rejectErr } = await supabase.from('document_actions')
        .update({ decision: 'rejected', decided_by: confirmed_by, decided_at: new Date().toISOString() })
        .eq('document_id', document_id)
        .in('action_type', rejected_actions)
      if (rejectErr) console.error('动作拒绝状态更新失败:', rejectErr.message)
    }

    // 执行（只执行approved的）
    const result = await executeDocumentActions(
      document_id,
      doc.doc_category as DocCategory,
      confirmed_fields || {},
      confirmed_by || '00000000-0000-0000-0000-000000000000',
      undefined,
      approved_actions // 传递给executor做过滤
    )

    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Execution failed' },
      { status: 500 }
    )
  }
}
