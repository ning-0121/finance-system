// ============================================================
// Document Intelligence Engine — AI提取核心
// Claude Vision: 分类 + OCR + 字段提取 一次完成
// ============================================================

import { FIELD_TEMPLATES, DOC_CATEGORY_LABELS, type DocCategory } from '@/lib/types/document'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''

const EXTRACTION_PROMPT = `你是绮陌服饰(QIMO Clothing)的财务文档智能分析引擎。

你的任务是分析上传的财务文档，完成以下工作：

1. **文件分类**：判断这个文档属于以下哪一类（给出类别代码和置信度0-1）：
${Object.entries(DOC_CATEGORY_LABELS).map(([k, v]) => `   - ${k}: ${v}`).join('\n')}

2. **字段提取**：根据文件类别，提取所有可识别的关键字段。

3. **金额处理**：所有金额必须精确到2位小数，移除千分位符号。

请严格按以下JSON格式返回（不要返回其他内容）：

{
  "doc_category": "类别代码",
  "confidence": 0.95,
  "extracted_fields": {
    "customer_name": "提取的客户名",
    "supplier_name": "提取的供应商名",
    "po_number": "PO号",
    "invoice_no": "发票号",
    "total_amount": 12345.67,
    "currency": "USD",
    "items": [{"name":"产品名","qty":100,"unit_price":12.50,"amount":1250.00}],
    ...其他字段
  },
  "summary": "一句话描述这个文档的内容"
}`

// --- 通过Claude Vision提取PDF/图片 ---
export async function extractWithVision(
  base64Content: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf',
  fileName: string
): Promise<ExtractionResult> {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY.includes('your_')) {
    return { success: false, error: 'ANTHROPIC_API_KEY not configured' }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType === 'application/pdf' ? 'image/png' : mediaType,
                data: base64Content,
              },
            },
            {
              type: 'text',
              text: `${EXTRACTION_PROMPT}\n\n文件名: ${fileName}`,
            },
          ],
        }],
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      return { success: false, error: `Claude API error: ${response.status} ${errText.slice(0, 200)}` }
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || ''

    // 解析JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { success: false, error: 'Claude did not return valid JSON' }
    }

    const parsed = JSON.parse(jsonMatch[0])
    return {
      success: true,
      doc_category: parsed.doc_category as DocCategory,
      confidence: parsed.confidence || 0.5,
      extracted_fields: parsed.extracted_fields || {},
      summary: parsed.summary || '',
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Extraction failed' }
  }
}

// --- 通过Excel列名提取（复用现有逻辑） ---
export function extractFromExcelHeaders(headers: string[], rows: Record<string, unknown>[]): ExtractionResult {
  // 复用detect-file-type的关键词匹配
  const { detectFileType } = require('@/lib/excel/detect-file-type')
  const detection = detectFileType(headers)

  // 映射到DocCategory
  const typeMapping: Record<string, DocCategory> = {
    supplier_invoice: 'supplier_invoice',
    freight_bill: 'logistics_bill',
    purchase_order: 'purchase_order',
    commercial_invoice: 'ci',
    packing_list: 'packing_list',
    internal_quote: 'pi',
    delivery_note: 'factory_delivery',
    processing_fee: 'supplier_invoice',
    bank_receipt: 'bank_receipt',
    general_cost: 'supplier_invoice',
  }

  const docCategory = typeMapping[detection.type] || 'supplier_invoice'

  // 尝试自动提取字段
  const fields: Record<string, unknown> = {}
  if (rows.length > 0) {
    const firstRow = rows[0]
    const lower = headers.map(h => h.toLowerCase())

    // 供应商/客户名
    const nameIdx = lower.findIndex(h => h.includes('供应商') || h.includes('客户') || h.includes('company') || h.includes('supplier'))
    if (nameIdx >= 0) fields.supplier_name = firstRow[headers[nameIdx]]

    // 总金额
    const totalIdx = lower.findIndex(h => h.includes('合计') || h.includes('总计') || h.includes('total'))
    if (totalIdx >= 0) fields.total_amount = firstRow[headers[totalIdx]]

    // 币种
    const curIdx = lower.findIndex(h => h.includes('币种') || h.includes('currency'))
    if (curIdx >= 0) fields.currency = firstRow[headers[curIdx]]

    // 发票号
    const invIdx = lower.findIndex(h => h.includes('发票') || h.includes('invoice') || h.includes('单号'))
    if (invIdx >= 0) fields.invoice_no = firstRow[headers[invIdx]]
  }

  return {
    success: true,
    doc_category: docCategory,
    confidence: detection.confidence,
    extracted_fields: fields,
    summary: `Excel文件，识别为${DOC_CATEGORY_LABELS[docCategory]}`,
  }
}

export interface ExtractionResult {
  success: boolean
  error?: string
  doc_category?: DocCategory
  confidence?: number
  extracted_fields?: Record<string, unknown>
  summary?: string
}
