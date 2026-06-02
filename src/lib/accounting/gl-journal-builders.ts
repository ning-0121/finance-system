// ============================================================
// GL 凭证构造器（纯函数，可单测）
//
// 每个业务事件 → JournalSpec（含借贷分录 + 完整 provenance）。
// 不访问数据库；所需数据由调用方（队列处理器）查好后传入。
//
// 关键安全点（受控灰度）：
//   - 外币缺汇率 → 抛 MISSING_RATE（绝不静默套默认 7.0）
//   - 源数据缺失 → 抛 MISSING_SOURCE_DOC
//   - 金额为 0/无需入账 → 返回 null（处理器标记 skipped）
//   - 每张凭证借贷自平衡，且带 relatedOrderId 等 provenance
// ============================================================

export type GlErrorCode =
  | 'MISSING_RATE'
  | 'PERIOD_CLOSED'
  | 'PERIOD_MISSING'
  | 'ACCOUNT_MISSING'
  | 'UNBALANCED'
  | 'RPC_FAILED'
  | 'RLS_FAILED'
  | 'FREEZE_BLOCKED'
  | 'DUPLICATE_SOURCE'
  | 'MISSING_SOURCE_DOC'
  | 'MISSING_PROVENANCE'
  | 'UNKNOWN'

export class GlPostingError extends Error {
  code: GlErrorCode
  constructor(code: GlErrorCode, message: string) {
    super(message)
    this.name = 'GlPostingError'
    this.code = code
  }
}

/** 把任意错误（含 RPC 报错文本）映射为失败类型码。 */
export function classifyGlError(err: unknown): GlErrorCode {
  if (err instanceof GlPostingError) return err.code
  // Supabase RPC 错误是带 .message 的普通对象（非 Error 实例），需一并提取
  let raw = ''
  if (err instanceof Error) raw = err.message
  else if (err && typeof err === 'object' && 'message' in err) raw = String((err as { message: unknown }).message ?? '')
  else raw = String(err ?? '')
  const msg = raw.toUpperCase()
  if (msg.includes('PERIOD_CLOSED')) return 'PERIOD_CLOSED'
  if (msg.includes('PERIOD_MISSING')) return 'PERIOD_MISSING'
  if (msg.includes('UNBALANCED')) return 'UNBALANCED'
  if (msg.includes('MISSING_PROVENANCE')) return 'MISSING_PROVENANCE'
  // 科目外键缺失
  if (msg.includes('ACCOUNT_CODE') || msg.includes('FOREIGN KEY') || msg.includes('VIOLATES FOREIGN KEY')) return 'ACCOUNT_MISSING'
  if (msg.includes('ROW-LEVEL SECURITY') || msg.includes('RLS') || msg.includes('PERMISSION DENIED')) return 'RLS_FAILED'
  if (msg.includes('DUPLICATE')) return 'DUPLICATE_SOURCE'
  return 'RPC_FAILED'
}

export interface SpecLine {
  account_code: string
  description: string
  debit: number
  credit: number
  currency?: string
  exchange_rate?: number
  original_amount?: number | null
  customer_id?: string | null
  supplier_name?: string | null
  order_id?: string | null
}

export interface JournalProvenance {
  relatedOrderId?: string | null
  relatedCustomerId?: string | null
  relatedSupplierName?: string | null
  sourceDocumentId?: string | null
  exchangeRateSource?: string | null
  explanation?: string | null
}

export interface JournalSpec {
  periodCode: string
  date: string
  description: string
  sourceType: string
  sourceId: string
  businessEvent: string
  targetJournalType: string
  amountCny: number
  lines: SpecLine[]
  provenance: JournalProvenance
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function periodCodeOf(date?: string): string {
  const d = date ? new Date(date) : new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 外币必须有正汇率，否则 MISSING_RATE（绝不套默认值）。 */
function resolveRate(currency: string | null | undefined, rate: number | null | undefined, ctx: string): number {
  if (!currency || currency === 'CNY') return 1
  const r = Number(rate)
  if (!Number.isFinite(r) || r <= 0) {
    throw new GlPostingError('MISSING_RATE', `${ctx}：外币 ${currency} 缺少有效汇率，已挂起待人工补汇率`)
  }
  return r
}

/** 银行存款科目：人民币户 100201，外币户 100202。 */
export function bankAccountForCurrency(currency?: string | null): string {
  return currency === 'CNY' || !currency ? '100201' : '100202'
}

// ── 输入类型 ──────────────────────────────────────────────
export interface RevenueOrderInput {
  id: string
  order_no: string
  customer_id?: string | null
  customer_company?: string | null
  currency: string
  exchange_rate: number | null
  total_revenue: number
  order_date: string
}

export interface CostOrderInput {
  id: string
  order_no: string
  order_date: string
  currency: string
  exchange_rate: number | null
  fabric: number
  accessory: number
  processing: number
  forwarder: number
  container: number
  logistics: number
  extras: { name: string; amount: number }[]
}

export interface ReceiptInput {
  order: RevenueOrderInput
  amountCnyDelta: number      // 已由处理器算好的「本次新增已收 CNY」
  bankCode?: string | null
  bankName?: string | null
}

export interface PaymentInput {
  id: string
  supplier_name: string
  amount: number
  currency: string
  exchange_rate?: number | null
  paid_at?: string | null
  bankCode?: string | null
}

// ── 构造器 ────────────────────────────────────────────────

/** 审批通过：借 应收账款1122 / 贷 主营业务收入。 */
export function buildRevenueRecognition(order: RevenueOrderInput): JournalSpec | null {
  if (!order || !order.id) throw new GlPostingError('MISSING_SOURCE_DOC', '订单不存在，无法确认收入')
  const rate = resolveRate(order.currency, order.exchange_rate, `订单 ${order.order_no} 收入`)
  const revenueCny = round2((Number(order.total_revenue) || 0) * rate)
  if (revenueCny <= 0) return null
  const revenueAccount = order.currency === 'CNY' ? '500102' : '500101'
  return {
    periodCode: periodCodeOf(order.order_date),
    date: order.order_date,
    description: `确认收入 ${order.order_no} ${order.customer_company || ''}`.trim(),
    sourceType: 'budget_order',
    sourceId: order.id,
    businessEvent: 'order_approved',
    targetJournalType: 'revenue_recognition',
    amountCny: revenueCny,
    lines: [
      { account_code: '1122', description: `应收-${order.customer_company || ''}`, debit: revenueCny, credit: 0, customer_id: order.customer_id ?? null, order_id: order.id },
      { account_code: revenueAccount, description: `收入-${order.order_no}`, debit: 0, credit: revenueCny, order_id: order.id },
    ],
    provenance: {
      relatedOrderId: order.id,
      relatedCustomerId: order.customer_id ?? null,
      exchangeRateSource: order.currency === 'CNY' ? 'CNY=1' : `budget_order.exchange_rate=${rate}`,
      explanation: `审批通过自动确认收入：${order.total_revenue} ${order.currency} × ${rate} = ¥${revenueCny}`,
    },
  }
}

/** 决算确认：借 各成本/费用科目 / 贷 应付账款2202。 */
export function buildCostRecognition(order: CostOrderInput): JournalSpec | null {
  if (!order || !order.id) throw new GlPostingError('MISSING_SOURCE_DOC', '订单不存在，无法结转成本')
  const rate = resolveRate(order.currency, order.exchange_rate, `订单 ${order.order_no} 成本`)
  const c = (n: number) => round2((Number(n) || 0) * rate)
  const lines: SpecLine[] = []
  const push = (code: string, label: string, amt: number) => {
    const v = c(amt)
    if (v > 0) lines.push({ account_code: code, description: label, debit: v, credit: 0, order_id: order.id })
  }
  push('540101', '面料成本', order.fabric)
  push('540102', '辅料成本', order.accessory)
  push('540103', '加工费', order.processing)
  push('540201', '货代费', order.forwarder)
  push('540202', '装柜费', order.container)
  push('540203', '物流费', order.logistics)
  for (const e of order.extras || []) {
    const v = c(e.amount)
    if (v > 0) lines.push({ account_code: '540204', description: e.name || '其他费用', debit: v, credit: 0, order_id: order.id })
  }
  const totalCny = round2(lines.reduce((s, l) => s + l.debit, 0))
  if (totalCny <= 0) return null
  lines.push({ account_code: '2202', description: `应付-${order.order_no}`, debit: 0, credit: totalCny, order_id: order.id })
  return {
    periodCode: periodCodeOf(order.order_date),
    date: order.order_date,
    description: `结转成本 ${order.order_no}`,
    sourceType: 'settlement',
    sourceId: order.id,
    businessEvent: 'settlement_confirmed',
    targetJournalType: 'cost_recognition',
    amountCny: totalCny,
    lines,
    provenance: {
      relatedOrderId: order.id,
      exchangeRateSource: order.currency === 'CNY' ? 'CNY=1' : `budget_order.exchange_rate=${rate}`,
      explanation: `决算确认自动结转成本（折算汇率 ${rate}）合计 ¥${totalCny}`,
    },
  }
}

/** 回款保存：借 银行存款 / 贷 应收账款1122（仅入「本次新增已收」差额）。 */
export function buildArReceipt(input: ReceiptInput): JournalSpec | null {
  const { order } = input
  if (!order || !order.id) throw new GlPostingError('MISSING_SOURCE_DOC', '订单不存在，无法登记收款')
  const delta = round2(Number(input.amountCnyDelta) || 0)
  if (delta <= 0) return null   // 金额未增加 → 无需入账（幂等）
  const bankCode = input.bankCode || bankAccountForCurrency(order.currency)
  return {
    periodCode: periodCodeOf(),
    date: new Date().toISOString().slice(0, 10),
    description: `收款 ${order.order_no} ${order.customer_company || ''}${input.bankName ? ' @' + input.bankName : ''}`.trim(),
    sourceType: 'receipt',
    sourceId: order.id,
    businessEvent: 'receipt_saved',
    targetJournalType: 'ar_receipt',
    amountCny: delta,
    lines: [
      { account_code: bankCode, description: `收款-${order.customer_company || ''}${input.bankName ? '(' + input.bankName + ')' : ''}`, debit: delta, credit: 0, customer_id: order.customer_id ?? null, order_id: order.id },
      { account_code: '1122', description: `核销应收-${order.order_no}`, debit: 0, credit: delta, customer_id: order.customer_id ?? null, order_id: order.id },
    ],
    provenance: {
      relatedOrderId: order.id,
      relatedCustomerId: order.customer_id ?? null,
      exchangeRateSource: 'cny_amount',
      explanation: `回款保存自动入账（本次新增已收 ¥${delta}，收款银行 ${input.bankName || '默认'}）`,
    },
  }
}

/** 付款登记：借 应付账款2202 / 贷 银行存款。 */
export function buildApPayment(input: PaymentInput): JournalSpec | null {
  if (!input || !input.id) throw new GlPostingError('MISSING_SOURCE_DOC', '付款记录不存在，无法入账')
  const rate = resolveRate(input.currency, input.exchange_rate, `供应商付款 ${input.supplier_name}`)
  const amountCny = round2((Number(input.amount) || 0) * rate)
  if (amountCny <= 0) return null
  const bankCode = input.bankCode || bankAccountForCurrency(input.currency)
  return {
    periodCode: periodCodeOf(input.paid_at || undefined),
    date: (input.paid_at || new Date().toISOString()).slice(0, 10),
    description: `付款 ${input.supplier_name}`,
    sourceType: 'supplier_payment',
    sourceId: input.id,
    businessEvent: 'payment_registered',
    targetJournalType: 'ap_payment',
    amountCny,
    lines: [
      { account_code: '2202', description: `付-${input.supplier_name}`, debit: amountCny, credit: 0, supplier_name: input.supplier_name },
      { account_code: bankCode, description: `银行付款-${input.supplier_name}`, debit: 0, credit: amountCny, supplier_name: input.supplier_name },
    ],
    provenance: {
      relatedSupplierName: input.supplier_name,
      exchangeRateSource: input.currency === 'CNY' ? 'CNY=1' : `supplier_payment.exchange_rate=${rate}`,
      explanation: `付款登记自动入账：${input.amount} ${input.currency} × ${rate} = ¥${amountCny}`,
    },
  }
}

/** 自检：分录借贷必须平衡（构造器内部已保证，用于测试与处理器双保险）。 */
export function isBalanced(spec: JournalSpec): boolean {
  const d = round2(spec.lines.reduce((s, l) => s + (l.debit || 0), 0))
  const c = round2(spec.lines.reduce((s, l) => s + (l.credit || 0), 0))
  return Math.abs(d - c) <= 0.001
}
