// ============================================================
// Document Intelligence Engine — 增强版AI提取核心
// 统一输出：分类+字段+置信度+缺失+风险+重复+模板
// ============================================================

import {
  FIELD_TEMPLATES, DOC_CATEGORY_LABELS, FORCED_CONFIRM_FIELDS,
  type DocCategory, type ExtractionResult,
} from '@/lib/types/document'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''

function buildExtractionPrompt(templateHint?: string): string {
  return `你是绮陌服饰(QIMO Clothing)的财务文档智能分析引擎。

你的任务是分析上传的财务文档，完成以下工作：

1. **文件分类**：判断属于哪一类（给出类别代码和置信度0-100）：
${Object.entries(DOC_CATEGORY_LABELS).map(([k, v]) => `   - ${k}: ${v}`).join('\n')}

2. **字段提取**：提取所有可识别的关键字段，并给出每个字段的置信度（0-100）。

3. **缺失字段**：列出该类型文件通常应有但你没能识别到的字段。

4. **高风险字段**：标出金额、币种、数量、客户名、供应商名等必须人工确认的字段。

5. **金额处理**：所有金额精确到2位小数，移除千分位。

${templateHint ? `\n6. **参考模板**：该实体的历史文件格式如下，请优先按此格式提取：\n${templateHint}\n` : ''}

请严格按以下JSON格式返回（不要返回其他内容）：

{
  "doc_category": "类别代码",
  "classification_confidence": 85,
  "extracted_fields": {
    "customer_name": "提取值",
    "total_amount": 12345.67,
    ...
  },
  "field_confidence": {
    "customer_name": 95,
    "total_amount": 90,
    ...
  },
  "missing_fields": ["未识别到的字段名"],
  "high_risk_fields": ["需人工确认的字段名"],
  "raw_text_summary": "一句话描述文档内容"
}`
}

// --- Claude Vision提取（增强版） ---
export async function extractWithVision(
  base64Content: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf',
  fileName: string,
  templateHint?: string
): Promise<ExtractionResult> {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY.includes('your_')) {
    return makeFailResult('ANTHROPIC_API_KEY not configured')
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
            { type: 'text', text: `${buildExtractionPrompt(templateHint)}\n\n文件名: ${fileName}` },
          ],
        }],
      }),
    })

    if (!response.ok) {
      return makeFailResult(`Claude API error: ${response.status}`)
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return makeFailResult('Claude did not return valid JSON')

    const parsed = JSON.parse(jsonMatch[0])
    const docCategory = parsed.doc_category as DocCategory
    const extractedFields = parsed.extracted_fields || {}
    const fieldConf = parsed.field_confidence || {}
    const missingFields = parsed.missing_fields || []

    // 计算高风险字段：强制确认字段中已提取的 + AI标记的
    const highRisk = [
      ...new Set([
        ...(parsed.high_risk_fields || []),
        ...FORCED_CONFIRM_FIELDS.filter(f => f in extractedFields),
      ]),
    ]

    return {
      success: true,
      doc_category: docCategory,
      classification_confidence: parsed.classification_confidence || 50,
      extracted_fields: extractedFields,
      field_confidence: fieldConf,
      missing_fields: missingFields,
      high_risk_fields: highRisk,
      duplicate_probability: 0, // 由matcher计算
      raw_text_summary: parsed.raw_text_summary || '',
      template_match_result: templateHint ? 'template_guided' : null,
      extraction_method: 'vision',
    }
  } catch (error) {
    return makeFailResult(error instanceof Error ? error.message : 'Extraction failed')
  }
}

// --- Excel提取（增强版） ---
export function extractFromExcelHeaders(
  headers: string[],
  rows: Record<string, unknown>[],
  templateHint?: string
): ExtractionResult {
  const { detectFileType } = require('@/lib/excel/detect-file-type')
  const detection = detectFileType(headers)

  const typeMapping: Record<string, DocCategory> = {
    supplier_invoice: 'supplier_invoice', freight_bill: 'logistics_bill',
    purchase_order: 'purchase_order', commercial_invoice: 'ci',
    packing_list: 'packing_list', internal_quote: 'pi',
    delivery_note: 'factory_delivery', processing_fee: 'supplier_invoice',
    bank_receipt: 'bank_receipt', general_cost: 'supplier_invoice',
  }

  const docCategory = typeMapping[detection.type] || 'supplier_invoice'
  const fields: Record<string, unknown> = {}
  const fieldConf: Record<string, number> = {}
  const lower = headers.map(h => h.toLowerCase())

  // 智能字段提取
  const mappings = [
    { targets: ['供应商', '客户', 'company', 'supplier', 'customer', '名称'], field: 'supplier_name', conf: 80 },
    { targets: ['合计', '总计', 'total', '金额', 'amount'], field: 'total_amount', conf: 85 },
    { targets: ['币种', 'currency', '货币'], field: 'currency', conf: 90 },
    { targets: ['发票', 'invoice', '单号', '编号'], field: 'invoice_no', conf: 75 },
    { targets: ['日期', 'date', '时间'], field: 'invoice_date', conf: 70 },
    { targets: ['po', '订单号', 'order'], field: 'po_number', conf: 75 },
    { targets: ['数量', 'qty', 'quantity'], field: 'qty', conf: 80 },
    { targets: ['单价', 'price', 'unit price'], field: 'unit_price', conf: 80 },
    { targets: ['税', 'tax', '税额'], field: 'tax_amount', conf: 70 },
  ]

  for (const m of mappings) {
    const idx = lower.findIndex(h => m.targets.some(t => h.includes(t)))
    if (idx >= 0 && rows.length > 0) {
      fields[m.field] = rows[0][headers[idx]]
      fieldConf[m.field] = m.conf
    }
  }

  // 如果有多行，尝试聚合总金额
  if (rows.length > 1 && !fields.total_amount) {
    const amtIdx = lower.findIndex(h => h.includes('金额') || h.includes('amount') || h.includes('总价'))
    if (amtIdx >= 0) {
      const total = rows.reduce((s, r) => {
        const v = Number(r[headers[amtIdx]]) || 0
        return s + v
      }, 0)
      if (total > 0) { fields.total_amount = Math.round(total * 100) / 100; fieldConf.total_amount = 70 }
    }
  }

  // 缺失字段检测
  const expectedFields = FIELD_TEMPLATES[docCategory]?.map(f => f.field) || []
  const missingFields = expectedFields.filter(f => !(f in fields) && f !== 'items')

  // 高风险字段
  const highRiskFields = FORCED_CONFIRM_FIELDS.filter(f => f in fields)

  return {
    success: true,
    doc_category: docCategory,
    classification_confidence: Math.round(detection.confidence * 100),
    extracted_fields: fields,
    field_confidence: fieldConf,
    missing_fields: missingFields,
    high_risk_fields: highRiskFields,
    duplicate_probability: 0,
    raw_text_summary: `Excel文件(${rows.length}行), 识别为${DOC_CATEGORY_LABELS[docCategory]}`,
    template_match_result: templateHint ? 'template_guided' : null,
    extraction_method: 'excel',
  }
}

function makeFailResult(error: string): ExtractionResult {
  return {
    success: false, error,
    doc_category: 'supplier_invoice',
    classification_confidence: 0,
    extracted_fields: {},
    field_confidence: {},
    missing_fields: [],
    high_risk_fields: [],
    duplicate_probability: 0,
    raw_text_summary: '',
    template_match_result: null,
    extraction_method: 'vision',
  }
}
