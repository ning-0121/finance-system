// ============================================================
// 内部报价单提取器 — PO 审批 → 预算草稿 专用
// 输出直接对齐 budget_orders.items[0]._cost_breakdown 的结构：
//   售价(数量/单价/币种/总额) + 成本行(bucket/描述/供应商/数量/单价/金额,人民币)
// 只做识别建议(读多写零)：结果存 uploaded_documents.extracted_fields，
// 预算落库由财务在 UI 调整确认后另行触发。
// ============================================================
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })

/** 成本桶：与预算单 _cost_breakdown.lines 的分组键一致 */
export const QUOTE_BUCKETS = ['fabric', 'accessory', 'processing', 'freight', 'commission', 'customs', 'other'] as const
export type QuoteBucket = typeof QUOTE_BUCKETS[number]
export const QUOTE_BUCKET_LABELS: Record<QuoteBucket, string> = {
  fabric: '面料', accessory: '辅料', processing: '加工费', freight: '运费',
  commission: '佣金', customs: '报关/关税', other: '其他',
}

export interface QuoteCostLine {
  bucket: QuoteBucket
  name: string            // 描述(如"深蓝色网纱"/"车缝加工")
  supplier?: string | null
  qty?: number | null
  unit?: string | null
  unit_price?: number | null
  amount: number          // 人民币金额(数量×单价或直接金额)
}

export interface QuoteExtraction {
  success: boolean
  error?: string
  order_no?: string | null       // 内部订单号/工厂号
  style_no?: string | null
  customer_name?: string | null
  quantity?: number | null       // 订单数量(件)
  unit?: string | null
  sell_price?: number | null     // 售价单价(原币)
  currency?: string | null       // 售价币种
  total_revenue?: number | null  // 售价总额(原币)
  exchange_rate?: number | null
  cost_lines: QuoteCostLine[]
  cost_total?: number | null     // 成本合计(人民币)
  raw_text_summary?: string
  field_confidence?: Record<string, number>
}

const QUOTE_PROMPT = `你是绮陌服饰(QIMO Clothing)的财务分析引擎。输入是一份【内部报价单/成本核算单】(服装外贸,一款一单)。

提取以下内容,严格按 JSON 返回(不要返回其他内容):

{
  "order_no": "内部订单号/工厂号(如 1022849),没有则 null",
  "style_no": "款号,没有则 null",
  "customer_name": "客户名,没有则 null",
  "quantity": 订单数量(数字,件数),
  "unit": "数量单位(件/pcs),没有则 null",
  "sell_price": 售价单价(数字,原币),
  "currency": "售价币种(USD/CNY/EUR...)",
  "total_revenue": 售价总额(数字,原币;没有则用 sell_price×quantity),
  "exchange_rate": 汇率(数字,报价单上标注的;没有则 null),
  "cost_lines": [
    {
      "bucket": "成本类别,只能取: fabric(面料)/accessory(辅料)/processing(加工费)/freight(运费)/commission(佣金)/customs(报关关税)/other(其他)",
      "name": "描述(面料名/辅料名/工序名等)",
      "supplier": "供应商名,没有则 null",
      "qty": 数量(数字,没有则 null),
      "unit": "单位(米/个/件),没有则 null",
      "unit_price": 单价(数字,人民币,没有则 null),
      "amount": 金额(数字,人民币;qty×unit_price 或表上直接给的金额)
    }
  ],
  "cost_total": 成本合计(数字,人民币;报价单上给的合计,没有则各行相加),
  "raw_text_summary": "一句话描述这份报价单",
  "field_confidence": { "sell_price": 0-100, "quantity": 0-100, "cost_lines": 0-100 }
}

规则:
- 金额精确到2位小数,去千分位。
- 报价单里的"损耗/用量"折进对应面辅料行,不单列。
- 分不清类别的行放 other,不要漏行——宁可放错桶也不能丢金额。
- 利润率/毛利等推导值不要提取(系统自己算)。`

function parseQuoteJson(text: string): QuoteExtraction {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return { success: false, error: '模型未返回有效 JSON', cost_lines: [] }
  try {
    const p = JSON.parse(m[0])
    const lines: QuoteCostLine[] = Array.isArray(p.cost_lines) ? p.cost_lines
      .filter((l: Record<string, unknown>) => l && (l.amount != null || l.unit_price != null))
      .map((l: Record<string, unknown>) => ({
        bucket: (QUOTE_BUCKETS as readonly string[]).includes(String(l.bucket)) ? l.bucket as QuoteBucket : 'other',
        name: String(l.name || '未命名'),
        supplier: (l.supplier as string) || null,
        qty: l.qty != null ? Number(l.qty) : null,
        unit: (l.unit as string) || null,
        unit_price: l.unit_price != null ? Number(l.unit_price) : null,
        amount: Math.round((Number(l.amount) || (Number(l.qty) || 0) * (Number(l.unit_price) || 0)) * 100) / 100,
      })) : []
    return {
      success: true,
      order_no: p.order_no || null, style_no: p.style_no || null, customer_name: p.customer_name || null,
      quantity: p.quantity != null ? Number(p.quantity) : null, unit: p.unit || null,
      sell_price: p.sell_price != null ? Number(p.sell_price) : null,
      currency: p.currency || null,
      total_revenue: p.total_revenue != null ? Number(p.total_revenue) : null,
      exchange_rate: p.exchange_rate != null ? Number(p.exchange_rate) : null,
      cost_lines: lines,
      cost_total: p.cost_total != null ? Number(p.cost_total) : Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
      raw_text_summary: p.raw_text_summary || '',
      field_confidence: p.field_confidence || {},
    }
  } catch (e) {
    return { success: false, error: `JSON 解析失败: ${e instanceof Error ? e.message : ''}`, cost_lines: [] }
  }
}

/** 从图片/PDF 提取内部报价单（PDF 用原生 document block，不冒充图片） */
export async function extractQuoteFromFile(
  base64Content: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf',
  fileName: string,
): Promise<QuoteExtraction> {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('your_')) {
    return { success: false, error: 'ANTHROPIC_API_KEY 未配置', cost_lines: [] }
  }
  try {
    const contentBlock: Anthropic.ContentBlockParam = mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Content } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Content } }
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: [{ type: 'text', text: QUOTE_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: `请提取此内部报价单。文件名: ${fileName}` }] }],
    })
    const tb = res.content.find(b => b.type === 'text')
    return parseQuoteJson(tb?.type === 'text' ? tb.text : '')
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '提取失败', cost_lines: [] }
  }
}

/** 从表格文本(Excel→CSV)提取内部报价单 */
export async function extractQuoteFromText(csvText: string, fileName: string): Promise<QuoteExtraction> {
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('your_')) {
    return { success: false, error: 'ANTHROPIC_API_KEY 未配置', cost_lines: [] }
  }
  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: [{ type: 'text', text: QUOTE_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `以下是报价单表格内容(CSV,文件名 ${fileName}):\n\n${csvText.slice(0, 60000)}` }],
    })
    const tb = res.content.find(b => b.type === 'text')
    return parseQuoteJson(tb?.type === 'text' ? tb.text : '')
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '提取失败', cost_lines: [] }
  }
}
