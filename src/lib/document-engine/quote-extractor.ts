// ============================================================
// 内部报价单提取器 — PO 审批 → 预算草稿 专用
// 输出直接对齐 budget_orders.items[0]._cost_breakdown 的结构：
//   售价(数量/单价/币种/总额) + 成本行(bucket/描述/供应商/数量/单价/金额,人民币)
// 只做识别建议(读多写零)：结果存 uploaded_documents.extracted_fields，
// 预算落库由财务在 UI 调整确认后另行触发。
// ============================================================
import Anthropic from '@anthropic-ai/sdk'
import { createWithBudget } from '@/lib/ai/spend-budget'

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

/** 多款核算单里的一款(绮陌真实格式:一款一行,单件人民币口径) */
export interface QuoteStyle {
  style_label: string            // 款标识(款号/面料名/成分,能区分即可)
  sell_price?: number | null     // 单件售价(人民币含税价)
  unit_cost?: number | null      // 单件成本合计
  cost_lines: QuoteCostLine[]    // 单件成本行(unit_price=单件金额)
}

export interface QuoteExtraction {
  success: boolean
  error?: string
  order_no?: string | null       // 内部订单号/工厂号
  style_no?: string | null
  customer_name?: string | null
  quantity?: number | null       // 订单数量(件;单件口径的核算单通常没有)
  unit?: string | null
  sell_price?: number | null     // 售价单价(原币)
  currency?: string | null       // 售价币种
  total_revenue?: number | null  // 售价总额(原币)
  exchange_rate?: number | null
  per_unit?: boolean             // true=单件成本口径(金额都是每件人民币,预算须×订单数量)
  styles?: QuoteStyle[]          // 多款核算单:每款一组;cost_lines 取第一款(兼容)
  cost_lines: QuoteCostLine[]
  cost_total?: number | null     // 成本合计(人民币;单件口径=单件成本)
  raw_text_summary?: string
  field_confidence?: Record<string, number>
}

const QUOTE_PROMPT = `你是绮陌服饰(QIMO Clothing)的财务分析引擎。输入是一份【内部报价单/成本核算单】(服装外贸)。

绮陌核算单最常见的格式是【单件成本口径、一款一行】:每行一个款(STYLE/面料成分区分),列有
"人民币含税价"(=单件售价)、"成本"(=单件成本合计)、"面料成本"、"加工价"、"辅料费用合计"、
面料A/面料B(面料名、面料工厂、净布价、单件用量)、备注(辅料明细如"拉链1.5+烫标0.3+基础辅料1.5=3.3")。
这种格式:per_unit=true,所有金额都是【每件人民币】,通常没有订单数量。
也可能是【整单口径】(有订单数量和总额):per_unit=false。

提取以下内容,严格按 JSON 返回(不要返回其他内容):

{
  "order_no": "内部订单号/工厂号(如 1022849),没有则 null",
  "style_no": "主款号,没有则 null",
  "customer_name": "客户名(表头/文件名里的,如 日本CLMB),没有则 null",
  "quantity": 订单数量(数字;单件口径通常没有→null),
  "unit": "数量单位(件/pcs),没有则 null",
  "sell_price": 售价单价(数字;单件口径=第一款的人民币含税价),
  "currency": "售价币种(单件含税价是人民币→CNY;整单口径按表上币种)",
  "total_revenue": 售价总额(数字;单件口径没有→null),
  "exchange_rate": 汇率(表上标注的;没有则 null),
  "per_unit": true/false(是否单件成本口径),
  "styles": [   // 每款一组;只有一款也放一组
    {
      "style_label": "款标识(款号;没有款号用 面料名/成分 区分,如 '2908 85%NYLON')",
      "sell_price": 该款单件售价(人民币含税价),
      "unit_cost": 该款单件成本合计,
      "cost_lines": [
        {
          "bucket": "只能取: fabric(面料)/accessory(辅料)/processing(加工费)/freight(运费)/commission(佣金)/customs(报关关税)/other(其他)",
          "name": "描述。面料行带面料名(如 '面料 2908');辅料按备注拆行(如 '拉链'/'烫标'/'基础辅料');加工行叫 '加工费'",
          "supplier": "供应商/工厂名(面料工厂列),没有则 null",
          "qty": 单件用量(数字,如 1.50;没有则 null),
          "unit": "用量单位(米/公斤),没有则 null",
          "unit_price": 单价(数字;面料=净布价;没有则 null),
          "amount": 该成本项的【单件金额】(数字,人民币)。面料=面料成本列(或净布价×用量);加工=加工价;辅料=各明细项金额
        }
      ]
    }
  ],
  "cost_lines": 第一款的 cost_lines(同上,兼容字段),
  "cost_total": 第一款的单件成本合计,
  "raw_text_summary": "一句话描述(几款、口径)",
  "field_confidence": { "sell_price": 0-100, "cost_lines": 0-100 }
}

规则:
- 金额精确到2位小数,去¥和千分位。
- 每款的 cost_lines 各行 amount 相加应≈该款"成本"列;对不上也要保持各行忠实于表格,不要凑数。
- 备注里的辅料算式(如"拉链1.5+烫标0.3+基础辅料1.5")拆成多行 accessory;拆不动就一行"辅料合计"。
- 损耗/用量折进对应行,不单列。分不清类别放 other,不要漏行——宁可放错桶也不能丢金额。
- 利润率/毛利/含税不含税换算等推导值不要提取(系统自己算)。`

function normLines(raw: unknown): QuoteCostLine[] {
  if (!Array.isArray(raw)) return []
  return (raw as Record<string, unknown>[])
    .filter(l => l && (l.amount != null || l.unit_price != null))
    .map(l => ({
      bucket: (QUOTE_BUCKETS as readonly string[]).includes(String(l.bucket)) ? l.bucket as QuoteBucket : 'other',
      name: String(l.name || '未命名'),
      supplier: (l.supplier as string) || null,
      qty: l.qty != null ? Number(l.qty) : null,
      unit: (l.unit as string) || null,
      unit_price: l.unit_price != null ? Number(l.unit_price) : null,
      amount: Math.round((Number(l.amount) || (Number(l.qty) || 0) * (Number(l.unit_price) || 0)) * 100) / 100,
    }))
}

function parseQuoteJson(text: string): QuoteExtraction {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return { success: false, error: '模型未返回有效 JSON', cost_lines: [] }
  try {
    const p = JSON.parse(m[0])
    // unit_cost/cost_total 一律按成本行求和 —— 表上常并列含税价/不含税价/成本三列,模型可能取错列;
    // 行求和与 UI 展示的行永远一致,也是预算落库的真实口径。
    const sumOf = (ls: QuoteCostLine[]) => Math.round(ls.reduce((s, l) => s + l.amount, 0) * 100) / 100
    const styles: QuoteStyle[] = Array.isArray(p.styles) ? (p.styles as Record<string, unknown>[]).map(s => {
      const ls = normLines(s.cost_lines)
      return {
        style_label: String(s.style_label || '未命名款'),
        sell_price: s.sell_price != null ? Number(s.sell_price) : null,
        unit_cost: sumOf(ls),
        cost_lines: ls,
      }
    }).filter(s => s.cost_lines.length > 0) : []
    const lines = normLines(p.cost_lines).length > 0 ? normLines(p.cost_lines) : (styles[0]?.cost_lines || [])
    return {
      success: true,
      order_no: p.order_no || null, style_no: p.style_no || null, customer_name: p.customer_name || null,
      quantity: p.quantity != null ? Number(p.quantity) : null, unit: p.unit || null,
      sell_price: p.sell_price != null ? Number(p.sell_price) : (styles[0]?.sell_price ?? null),
      currency: p.currency || null,
      total_revenue: p.total_revenue != null ? Number(p.total_revenue) : null,
      exchange_rate: p.exchange_rate != null ? Number(p.exchange_rate) : null,
      per_unit: p.per_unit === true,
      styles: styles.length > 0 ? styles : undefined,
      cost_lines: lines,
      cost_total: sumOf(lines),
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
    const res = await createWithBudget(client, {
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: [{ type: 'text', text: QUOTE_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: `请提取此内部报价单。文件名: ${fileName}` }] }],
    }, 'quote_extract_file')
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
    const res = await createWithBudget(client, {
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: [{ type: 'text', text: QUOTE_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `以下是报价单表格内容(CSV,文件名 ${fileName}):\n\n${csvText.slice(0, 60000)}` }],
    }, 'quote_extract_text')
    const tb = res.content.find(b => b.type === 'text')
    return parseQuoteJson(tb?.type === 'text' ? tb.text : '')
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '提取失败', cost_lines: [] }
  }
}
