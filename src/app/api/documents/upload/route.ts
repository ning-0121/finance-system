// ============================================================
// POST /api/documents/upload — 完整文档智能处理流程
// 去重检测 → 模板加载 → AI提取 → 字段验证 → 自动匹配 → 建议生成
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { extractWithVision, extractFromExcelHeaders } from '@/lib/document-engine/extractor'
import { autoMatch, calculateDuplicateProbability, generateSuggestedActions } from '@/lib/document-engine/matcher'
import type { FileType, ExtractionResult } from '@/lib/types/document'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    if (!file) return NextResponse.json({ error: '请上传文件' }, { status: 400 })

    const fileName = file.name
    const fileSize = file.size
    const ext = fileName.split('.').pop()?.toLowerCase() || ''

    let fileType: FileType = 'image'
    if (['xlsx', 'xls', 'csv'].includes(ext)) fileType = 'excel'
    else if (ext === 'pdf') fileType = 'pdf'
    else if (['doc', 'docx'].includes(ext)) fileType = 'word'

    const supabase = await createClient()

    // ========== Step 1: 文件去重预检 ==========
    const { data: existingFile } = await supabase
      .from('uploaded_documents')
      .select('id, file_name, status')
      .eq('file_name', fileName)
      .eq('file_size', fileSize)
      .limit(1)

    const preCheckDuplicate = existingFile?.length ? 80 : 0

    // ========== Step 2: 创建文档记录 ==========
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

    // ========== Step 3: 加载模板记忆 ==========
    let templateHint: string | undefined
    // 从文件名猜测entity名（常见模式：供应商名_发票_日期.xlsx）
    const possibleEntity = fileName.replace(/[_\-\.](xlsx|xls|csv|pdf|jpg|png)$/i, '').split(/[_\-\s]/)[0]
    if (possibleEntity.length > 2) {
      const { data: template } = await supabase
        .from('extraction_templates')
        .select('column_mapping, doc_category, entity_name')
        .ilike('entity_name', `%${possibleEntity}%`)
        .order('usage_count', { ascending: false })
        .limit(1)

      if (template?.length) {
        templateHint = `历史模板(${template[0].entity_name}): ${JSON.stringify(template[0].column_mapping)}`
      }
    }

    // ========== Step 4: AI提取 ==========
    let extraction: ExtractionResult
    if (fileType === 'excel') {
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellFormula: false, cellDates: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '', blankrows: false }) as Record<string, unknown>[]
      const headers = rows.length > 0 ? Object.keys(rows[0]) : []
      extraction = extractFromExcelHeaders(headers, rows, templateHint)
    } else {
      const buffer = await file.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')
      const mediaType = fileType === 'pdf' ? 'application/pdf' as const
        : ext === 'png' ? 'image/png' as const : 'image/jpeg' as const
      extraction = await extractWithVision(base64, mediaType, fileName, templateHint)
    }

    if (!extraction.success) {
      await supabase.from('uploaded_documents').update({
        status: 'pending',
        extracted_fields: { error: extraction.error },
      }).eq('id', doc.id)
      return NextResponse.json({ document_id: doc.id, status: 'extraction_failed', error: extraction.error })
    }

    // ========== Step 5: 自动匹配 ==========
    let matches: Awaited<ReturnType<typeof autoMatch>> = []
    try {
      // 服务端简化匹配
      const f = extraction.extracted_fields
      const customerName = (f.customer_name || f.payer_name) as string
      const supplierName = (f.supplier_name || f.factory_name || f.logistics_company) as string
      const invoiceNo = (f.invoice_no || f.reference_no) as string
      const poNumber = (f.po_number || f.order_no) as string

      if (customerName) {
        const { data } = await supabase.from('customers').select('id, company').ilike('company', `%${customerName}%`).limit(1)
        if (data?.length) {
          const conf = data[0].company.toLowerCase() === customerName.toLowerCase() ? 95 : 70
          matches.push({ type: 'customer', confidence: conf, confidence_level: conf >= 80 ? 'high' : 'medium', matched_id: data[0].id, matched_name: data[0].company, detail: `匹配客户: ${data[0].company}` })
        }
      }
      if (supplierName) {
        const { data } = await supabase.from('supplier_financial_profiles').select('id, supplier_name').ilike('supplier_name', `%${supplierName}%`).limit(1)
        if (data?.length) matches.push({ type: 'supplier', confidence: 80, confidence_level: 'high', matched_id: data[0].id, matched_name: data[0].supplier_name, detail: `匹配供应商: ${data[0].supplier_name}` })
      }
      if (poNumber) {
        const { data } = await supabase.from('budget_orders').select('id, order_no').or(`order_no.ilike.%${poNumber}%`).limit(1)
        if (data?.length) matches.push({ type: 'order', confidence: 90, confidence_level: 'high', matched_id: data[0].id, matched_name: data[0].order_no, detail: `匹配订单: ${data[0].order_no}` })
      }
      if (invoiceNo) {
        const { data } = await supabase.from('actual_invoices').select('id, invoice_no').eq('invoice_no', invoiceNo).limit(1)
        if (data?.length) matches.push({ type: 'duplicate', confidence: 100, confidence_level: 'high', matched_id: data[0].id, matched_name: invoiceNo, detail: `⚠️ 重复: 发票号已存在` })
      }
    } catch { /* matching best-effort */ }

    // ========== Step 6: 重复概率 ==========
    const duplicateProbability = Math.max(
      preCheckDuplicate,
      matches.some(m => m.type === 'duplicate') ? 90 : 0
    )
    extraction.duplicate_probability = duplicateProbability

    // ========== Step 7: 生成建议操作 ==========
    const suggestedActions = generateSuggestedActions(extraction.doc_category, extraction.extracted_fields, matches)

    // ========== Step 8: 写入数据库 ==========
    await supabase.from('uploaded_documents').update({
      status: 'extracted',
      doc_category: extraction.doc_category,
      doc_category_confidence: extraction.classification_confidence / 100,
      extracted_fields: {
        ...extraction.extracted_fields,
        _summary: extraction.raw_text_summary,
        _matches: matches,
        _field_confidence: extraction.field_confidence,
        _missing_fields: extraction.missing_fields,
        _high_risk_fields: extraction.high_risk_fields,
        _duplicate_probability: duplicateProbability,
        _extraction_method: extraction.extraction_method,
      },
      matched_customer: matches.find(m => m.type === 'customer')?.matched_name || null,
      matched_supplier: matches.find(m => m.type === 'supplier')?.matched_name || null,
      matched_order_id: matches.find(m => m.type === 'order')?.matched_id || null,
      template_id: templateHint ? 'template_used' : null,
    }).eq('id', doc.id)

    // 插入建议操作
    if (suggestedActions.length) {
      await supabase.from('document_actions').insert(
        suggestedActions.map(a => ({ document_id: doc.id, action_type: a.action_type, action_data: a.action_data }))
      )
    }

    return NextResponse.json({
      document_id: doc.id,
      status: 'extracted',
      doc_category: extraction.doc_category,
      classification_confidence: extraction.classification_confidence,
      extracted_fields: extraction.extracted_fields,
      field_confidence: extraction.field_confidence,
      missing_fields: extraction.missing_fields,
      high_risk_fields: extraction.high_risk_fields,
      duplicate_probability: duplicateProbability,
      summary: extraction.raw_text_summary,
      matches,
      suggested_actions: suggestedActions,
      template_used: !!templateHint,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Upload failed' }, { status: 500 })
  }
}
