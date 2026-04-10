// ============================================================
// POST /api/documents/execute — 确认后执行所有建议动作
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { executeDocumentActions } from '@/lib/document-engine/executor'
import type { DocCategory } from '@/lib/types/document'

export async function POST(request: Request) {
  try {
    const { document_id, confirmed_fields, confirmed_by } = await request.json()

    if (!document_id) {
      return NextResponse.json({ error: 'Missing document_id' }, { status: 400 })
    }

    const supabase = await createClient()

    // 获取文档信息
    const { data: doc } = await supabase
      .from('uploaded_documents')
      .select('doc_category, status')
      .eq('id', document_id)
      .single()

    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    if (doc.status === 'confirmed') return NextResponse.json({ error: 'Already confirmed' }, { status: 400 })

    // 执行
    const result = await executeDocumentActions(
      document_id,
      doc.doc_category as DocCategory,
      confirmed_fields || {},
      confirmed_by || '00000000-0000-0000-0000-000000000000'
    )

    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Execution failed' },
      { status: 500 }
    )
  }
}
