// ============================================================
// POST /api/documents/upload — 上传文件并触发AI提取
// 支持Excel/PDF/图片
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { extractWithVision, extractFromExcelHeaders } from '@/lib/document-engine/extractor'
import { autoMatch, generateSuggestedActions } from '@/lib/document-engine/matcher'
import type { FileType, DocCategory } from '@/lib/types/document'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: '请上传文件' }, { status: 400 })
    }

    const fileName = file.name
    const fileSize = file.size

    // 判断文件类型
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    let fileType: FileType = 'image'
    if (['xlsx', 'xls', 'csv'].includes(ext)) fileType = 'excel'
    else if (ext === 'pdf') fileType = 'pdf'
    else if (['doc', 'docx'].includes(ext)) fileType = 'word'
    else if (['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext)) fileType = 'image'

    const supabase = await createClient()

    // 1. 创建文档记录
    const { data: doc, error: insertError } = await supabase
      .from('uploaded_documents')
      .insert({
        file_name: fileName,
        file_type: fileType,
        file_size: fileSize,
        status: 'extracting',
      })
      .select()
      .single()

    if (insertError || !doc) {
      return NextResponse.json({ error: insertError?.message || 'Insert failed' }, { status: 500 })
    }

    // 2. 提取字段
    let extraction
    if (fileType === 'excel') {
      // Excel走现有解析
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellFormula: false, cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '', blankrows: false }) as Record<string, unknown>[]
      const headers = rows.length > 0 ? Object.keys(rows[0]) : []
      extraction = extractFromExcelHeaders(headers, rows)
    } else {
      // PDF/图片走Claude Vision
      const buffer = await file.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')
      const mediaType = fileType === 'pdf' ? 'application/pdf' as const
        : ext === 'png' ? 'image/png' as const
        : 'image/jpeg' as const
      extraction = await extractWithVision(base64, mediaType, fileName)
    }

    if (!extraction.success) {
      await supabase.from('uploaded_documents').update({
        status: 'pending',
        extracted_fields: { error: extraction.error },
      }).eq('id', doc.id)

      return NextResponse.json({
        document_id: doc.id,
        status: 'extraction_failed',
        error: extraction.error,
      })
    }

    // 3. 自动匹配
    let matches: Awaited<ReturnType<typeof autoMatch>> = []
    try {
      // autoMatch uses browser client, for server we do simplified matching
      const matchFields = extraction.extracted_fields || {}
      // Store matches info in extracted_fields
      const customerName = (matchFields.customer_name || matchFields.payer_name || matchFields.supplier_name) as string
      if (customerName) {
        const { data: customers } = await supabase.from('customers').select('id, company').ilike('company', `%${customerName}%`).limit(1)
        if (customers?.length) {
          matches.push({ type: 'customer', confidence: 0.8, matched_id: customers[0].id, matched_name: customers[0].company, detail: `匹配客户: ${customers[0].company}` })
        }
      }
    } catch { /* matching is best-effort */ }

    // 4. 生成建议操作
    const suggestedActions = generateSuggestedActions(
      extraction.doc_category!,
      extraction.extracted_fields || {},
      matches
    )

    // 5. 更新文档记录
    await supabase.from('uploaded_documents').update({
      status: 'extracted',
      doc_category: extraction.doc_category,
      doc_category_confidence: extraction.confidence,
      extracted_fields: {
        ...extraction.extracted_fields,
        _summary: extraction.summary,
        _matches: matches,
      },
      matched_customer: matches.find(m => m.type === 'customer')?.matched_name || null,
      matched_supplier: matches.find(m => m.type === 'supplier')?.matched_name || null,
      matched_order_id: matches.find(m => m.type === 'order')?.matched_id || null,
    }).eq('id', doc.id)

    // 6. 插入建议操作
    if (suggestedActions.length) {
      await supabase.from('document_actions').insert(
        suggestedActions.map(a => ({ document_id: doc.id, ...a }))
      )
    }

    return NextResponse.json({
      document_id: doc.id,
      status: 'extracted',
      doc_category: extraction.doc_category,
      confidence: extraction.confidence,
      extracted_fields: extraction.extracted_fields,
      summary: extraction.summary,
      matches,
      suggested_actions: suggestedActions.length,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
