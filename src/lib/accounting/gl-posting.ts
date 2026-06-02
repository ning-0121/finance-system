// 总账自动记账模块 — 业务单据→记账凭证
// 对标金蝶/用友的自动凭证生成
import { createClient } from '@/lib/supabase/server'
import type { BudgetOrder } from '@/lib/types'
import { requireRate, sumAmounts, mulAmount } from './utils'

interface JournalLine {
  account_code: string
  description: string
  debit: number
  credit: number
  currency?: string
  exchange_rate?: number
  original_amount?: number
  customer_id?: string
  supplier_name?: string
  order_id?: string
}

/**
 * 获取当前会计期间代码
 */
function getPeriodCode(date?: string): string {
  const d = date ? new Date(date) : new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 原子创建记账凭证（header + lines 在同一 DB 事务内）
 * 通过 RPC create_journal_atomic 消除"header 写成功但 lines 失败"的孤立凭证风险。
 */
async function createJournal(params: {
  periodCode: string
  date: string
  description: string
  sourceType: string
  sourceId: string
  lines: JournalLine[]
  createdBy?: string
}) {
  const supabase = await createClient()

  // 获取创建者
  let createdBy = params.createdBy
  if (!createdBy) {
    const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
    createdBy = profiles?.[0]?.id
  }
  if (!createdBy) throw new Error('无法确定凭证创建者，请确认用户已登录')

  // 精确累加（Decimal.js 避免浮点误差导致借贷不平衡误判）
  const totalDebit = sumAmounts(params.lines.map(l => l.debit))
  const totalCredit = sumAmounts(params.lines.map(l => l.credit))

  // 预检借贷平衡（RPC 内也会检查，此处提前报错提升可读性）
  if (Math.abs(totalDebit - totalCredit) > 0.001) {
    throw new Error(`凭证借贷不平衡: 借方${totalDebit} ≠ 贷方${totalCredit}`)
  }

  // 构建明细行 JSON（mulAmount 确保每行精度）
  const linesJson = params.lines.map((line, idx) => ({
    line_no: idx + 1,
    account_code: line.account_code,
    description: line.description ?? '',
    debit: mulAmount(line.debit, 1),
    credit: mulAmount(line.credit, 1),
    currency: line.currency ?? 'CNY',
    exchange_rate: line.exchange_rate ?? 1,
    original_amount: line.original_amount ?? null,
    customer_id: line.customer_id ?? null,
    supplier_name: line.supplier_name ?? null,
    order_id: line.order_id ?? null,
  }))

  // 调用原子 RPC —— header + lines 在同一事务，任何失败整体回滚
  const { data, error } = await supabase.rpc('create_journal_atomic', {
    p_period_code:  params.periodCode,
    p_date:         params.date,
    p_description:  params.description,
    p_source_type:  params.sourceType,
    p_source_id:    params.sourceId,
    p_total_debit:  totalDebit,
    p_total_credit: totalCredit,
    p_voucher_type: 'auto',
    p_created_by:   createdBy,
    p_lines:        linesJson,
  })

  if (error) throw new Error(`创建凭证失败: ${error.message}`)

  const result = data as { journal_id: string; voucher_no: string }
  return { journalId: result.journal_id, voucherNo: result.voucher_no }
}

/**
 * 幂等防重复过账：查询某业务单据是否已有未作废的凭证。
 * DB 层「故意」不对 (source_type, source_id) 设唯一索引（多次回款/付款合法），
 * 因此「一次性」事件（确认收入、结转成本）必须由应用层在过账前自检，避免重复记账。
 */
async function alreadyPosted(sourceType: string, sourceId: string): Promise<boolean> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)
    .neq('status', 'voided')
    .limit(1)
  return !!(data && data.length > 0)
}

/**
 * 已过账的「净收款」CNY（针对某订单的全部 receipt 凭证）：
 *   净 = Σ(银行借方) − Σ(银行贷方)，用于增量收款过账时计算 delta。
 */
async function netPostedReceiptCny(orderId: string): Promise<number> {
  const supabase = await createClient()
  const { data: entries } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('source_type', 'receipt')
    .eq('source_id', orderId)
    .eq('status', 'posted')
  const ids = (entries || []).map(e => e.id as string)
  if (ids.length === 0) return 0
  const { data: lines } = await supabase
    .from('journal_lines')
    .select('debit, credit, account_code, journal_id')
    .in('journal_id', ids)
    .in('account_code', ['100201', '100202'])
  return sumAmounts((lines || []).map(l => (Number(l.debit) || 0) - (Number(l.credit) || 0)))
}

/**
 * 订单确认收入凭证
 * 借: 应收账款    (收入CNY)
 * 贷: 主营业务收入 (收入CNY)
 */
export async function postRevenueRecognition(order: BudgetOrder) {
  // 幂等：一张订单只确认一次收入
  if (await alreadyPosted('budget_order', order.id)) {
    return { journalId: null, voucherNo: null, skipped: true as const }
  }
  const rate = requireRate(order.exchange_rate, order.currency, `确认收入 ${order.order_no}`)
  const revenueCny = mulAmount(order.total_revenue, rate)
  const revenueAccount = order.currency === 'CNY' ? '500102' : '500101'

  return createJournal({
    periodCode: getPeriodCode(order.order_date),
    date: order.order_date,
    description: `确认收入 ${order.order_no} ${order.customer?.company || ''}`,
    sourceType: 'budget_order',
    sourceId: order.id,
    lines: [
      { account_code: '1122', description: `应收-${order.customer?.company || ''}`, debit: revenueCny, credit: 0, customer_id: order.customer_id, order_id: order.id },
      { account_code: revenueAccount, description: `收入-${order.order_no}`, debit: 0, credit: revenueCny, order_id: order.id },
    ],
  })
}

/**
 * 订单成本凭证（决算确认时）
 * 借: 主营业务成本-面料/辅料/加工费  (各项成本)
 * 借: 销售费用-货代/装柜/物流/佣金   (各项费用)
 * 贷: 应付账款                      (总成本)
 */
export async function postCostRecognition(order: BudgetOrder) {
  // 幂等：一张订单只结转一次成本
  if (await alreadyPosted('settlement', order.id)) {
    return { journalId: null, voucherNo: null, skipped: true as const }
  }
  const bd = (order.items as unknown as Record<string, unknown>[])?.[0]
  const cb = bd?._cost_breakdown as Record<string, number | string> | undefined

  const fabric = Number(cb?.fabric) || order.target_purchase_price || 0
  const accessory = Number(cb?.accessory) || 0
  const processing = Number(cb?.processing) || order.estimated_commission || 0
  const forwarder = Number(cb?.forwarder) || order.estimated_freight || 0
  const container = Number(cb?.container) || order.estimated_customs_fee || 0
  const logistics = Number(cb?.logistics) || order.other_costs || 0
  const extras = (cb?.extras as unknown as { name: string; amount: number }[]) || []
  const extrasTotal = extras.reduce((s, e) => s + (e.amount || 0), 0)

  const lines: JournalLine[] = []

  if (fabric > 0) lines.push({ account_code: '540101', description: '面料成本', debit: fabric, credit: 0, order_id: order.id })
  if (accessory > 0) lines.push({ account_code: '540102', description: '辅料成本', debit: accessory, credit: 0, order_id: order.id })
  if (processing > 0) lines.push({ account_code: '540103', description: '加工费', debit: processing, credit: 0, order_id: order.id })
  if (forwarder > 0) lines.push({ account_code: '540201', description: '货代费', debit: forwarder, credit: 0, order_id: order.id })
  if (container > 0) lines.push({ account_code: '540202', description: '装柜费', debit: container, credit: 0, order_id: order.id })
  if (logistics > 0) lines.push({ account_code: '540203', description: '物流费', debit: logistics, credit: 0, order_id: order.id })
  extras.forEach(e => {
    if (e.amount > 0) lines.push({ account_code: '540204', description: e.name || '其他费用', debit: e.amount, credit: 0, order_id: order.id })
  })

  const totalCost = fabric + accessory + processing + forwarder + container + logistics + extrasTotal
  if (totalCost > 0) {
    lines.push({ account_code: '2202', description: `应付-${order.order_no}`, debit: 0, credit: totalCost, order_id: order.id })
  }

  if (lines.length === 0) return null

  return createJournal({
    periodCode: getPeriodCode(order.order_date),
    date: new Date().toISOString().substring(0, 10),
    description: `结转成本 ${order.order_no}`,
    sourceType: 'settlement',
    sourceId: order.id,
    lines,
  })
}

/**
 * 收款凭证
 * 借: 银行存款     (收款金额)
 * 贷: 应收账款     (收款金额)
 * 借/贷: 汇兑损益   (如有)
 */
export async function postPaymentReceived(params: {
  orderId: string
  orderNo: string
  customerName: string
  customerId: string
  amountCny: number
  originalAmount?: number
  currency?: string
  exchangeRate?: number
  bankAccountCode?: string
}) {
  const bankCode = params.bankAccountCode || (params.currency === 'CNY' ? '100201' : '100202')

  const lines: JournalLine[] = [
    { account_code: bankCode, description: `收款-${params.customerName}`, debit: params.amountCny, credit: 0, customer_id: params.customerId, order_id: params.orderId },
    { account_code: '1122', description: `核销应收-${params.orderNo}`, debit: 0, credit: params.amountCny, customer_id: params.customerId, order_id: params.orderId },
  ]

  return createJournal({
    periodCode: getPeriodCode(),
    date: new Date().toISOString().substring(0, 10),
    description: `收款 ${params.orderNo} ${params.customerName}`,
    sourceType: 'receipt',
    sourceId: params.orderId,
    lines,
  })
}

/**
 * 付款凭证
 * 借: 应付账款     (付款金额)
 * 贷: 银行存款     (付款金额)
 */
export async function postPaymentMade(params: {
  payableId: string
  orderNo: string
  supplierName: string
  amountCny: number
  orderId?: string
}) {
  return createJournal({
    periodCode: getPeriodCode(),
    date: new Date().toISOString().substring(0, 10),
    description: `付款 ${params.orderNo} ${params.supplierName}`,
    sourceType: 'payment',
    sourceId: params.payableId,
    lines: [
      { account_code: '2202', description: `付-${params.supplierName}`, debit: params.amountCny, credit: 0, supplier_name: params.supplierName, order_id: params.orderId },
      { account_code: '100201', description: `银行付款-${params.orderNo}`, debit: 0, credit: params.amountCny, order_id: params.orderId },
    ],
  })
}

/**
 * 收款同步过账（增量）— 应收收款采用「累计金额」模型（budget_orders.ar_received_amount），
 * 每次保存把 GL 与累计收款对齐，只过账差额，天然幂等：
 *   delta = 累计收款CNY − 已过账净收款CNY
 *   delta>0：借 银行 / 贷 应收（新增收款）
 *   delta<0：借 应收 / 贷 银行（收款修正/冲回）
 * 注：本版按订单预算汇率折算，应收可整洁核销；已实现汇兑损益留待期末重估处理。
 */
export async function postOrderReceiptSync(orderId: string) {
  const supabase = await createClient()
  const { data: order } = await supabase
    .from('budget_orders')
    .select('id, order_no, currency, exchange_rate, ar_received_amount, ar_received_bank, customer_id, customers(company)')
    .eq('id', orderId)
    .single()
  if (!order) throw new Error('订单不存在，无法过账收款')

  const rate = requireRate(order.exchange_rate as number, order.currency as string, `收款过账 ${order.order_no}`)
  const receivedCcy = Number(order.ar_received_amount) || 0
  const newCumulativeCny = mulAmount(receivedCcy, rate)
  const alreadyCny = await netPostedReceiptCny(orderId)
  const delta = Math.round((newCumulativeCny - alreadyCny) * 100) / 100

  if (Math.abs(delta) < 0.01) {
    return { journalId: null, voucherNo: null, skipped: true as const, delta: 0 }
  }

  const bankCode = order.currency === 'CNY' ? '100201' : '100202'
  const cust = order.customers as unknown as { company?: string } | null
  const customerName = cust?.company || ''
  const lines: JournalLine[] = delta > 0
    ? [
        { account_code: bankCode, description: `收款-${customerName}`, debit: delta, credit: 0, customer_id: order.customer_id as string, order_id: orderId },
        { account_code: '1122', description: `核销应收-${order.order_no}`, debit: 0, credit: delta, customer_id: order.customer_id as string, order_id: orderId },
      ]
    : [
        { account_code: '1122', description: `应收回冲-${order.order_no}`, debit: -delta, credit: 0, customer_id: order.customer_id as string, order_id: orderId },
        { account_code: bankCode, description: `收款冲回-${customerName}`, debit: 0, credit: -delta, customer_id: order.customer_id as string, order_id: orderId },
      ]

  const res = await createJournal({
    periodCode: getPeriodCode(),
    date: new Date().toISOString().substring(0, 10),
    description: `收款 ${order.order_no} ${customerName}`,
    sourceType: 'receipt',
    sourceId: orderId,
    lines,
  })
  return { ...res, skipped: false as const, delta }
}

/**
 * 供应商付款过账 — supplier_payments 每行一笔付款（登记口径为人民币）：
 *   借 应付账款 2202 / 贷 银行存款 100201
 * 幂等：按 (supplier_payment, paymentId) 自检，重复触发不重记。
 */
export async function postSupplierPayment(paymentId: string) {
  if (await alreadyPosted('supplier_payment', paymentId)) {
    return { journalId: null, voucherNo: null, skipped: true as const }
  }
  const supabase = await createClient()
  const { data: pay } = await supabase
    .from('supplier_payments')
    .select('id, supplier_name, amount, currency, paid_at, deleted_at')
    .eq('id', paymentId)
    .single()
  if (!pay) throw new Error('付款记录不存在，无法过账')
  if (pay.deleted_at) return { journalId: null, voucherNo: null, skipped: true as const }

  // 登记付款为人民币口径（登记入口仅收人民币金额）；如未来扩展外币付款需带汇率。
  const amountCny = mulAmount(Number(pay.amount) || 0, 1)
  if (amountCny <= 0) return { journalId: null, voucherNo: null, skipped: true as const }
  const supplierName = (pay.supplier_name as string) || '未指定供应商'

  const res = await createJournal({
    periodCode: getPeriodCode((pay.paid_at as string) || undefined),
    date: ((pay.paid_at as string) || new Date().toISOString()).substring(0, 10),
    description: `付款 ${supplierName}`,
    sourceType: 'supplier_payment',
    sourceId: paymentId,
    lines: [
      { account_code: '2202', description: `付-${supplierName}`, debit: amountCny, credit: 0, supplier_name: supplierName },
      { account_code: '100201', description: `银行付款-${supplierName}`, debit: 0, credit: amountCny, supplier_name: supplierName },
    ],
  })
  return { ...res, skipped: false as const }
}

/**
 * 查询试算平衡表
 */
export async function getTrialBalance(periodCode: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('gl_balances')
    .select('*, accounts(account_name, account_type, balance_direction)')
    .eq('period_code', periodCode)
    .order('account_code')

  if (error) throw error
  return data || []
}

/**
 * 查询科目明细（某科目某期间的所有凭证行）
 */
export async function getAccountDetail(accountCode: string, periodCode: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('journal_lines')
    .select('*, journal_entries(voucher_no, voucher_date, description, status)')
    .eq('account_code', accountCode)
    .order('created_at')

  if (error) throw error
  // 筛选期间
  return (data || []).filter((d: Record<string, unknown>) => {
    const je = d['journal_entries'] as Record<string, unknown>
    return je && (je['voucher_no'] as string)?.includes(periodCode.replace('-', ''))
  })
}

// gl_balances 行的本地类型（无 DB 类型定义时，手动约束）
interface GlBalanceRow {
  account_code: string
  period_debit: number | null
  period_credit: number | null
  accounts: { account_name: string; account_type: string } | null
}

/**
 * 查询利润表数据（P&L）
 */
export async function getProfitAndLoss(periodCode: string) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('gl_balances')
    .select('account_code, period_debit, period_credit, accounts(account_name, account_type)')
    .eq('period_code', periodCode)
    .in('account_code', ['500101', '500102', '5051', '5301', '540101', '540102', '540103', '540201', '540202', '540203', '540204', '540205', '5403', '5601'])

  const rows = (data || []) as unknown as GlBalanceRow[]

  const revenue = rows
    .filter((d) => d.accounts?.account_type === 'revenue')
    .reduce((s: number, d) => s + (d.period_credit ?? 0) - (d.period_debit ?? 0), 0)

  const expense = rows
    .filter((d) => d.accounts?.account_type === 'expense')
    .reduce((s: number, d) => s + (d.period_debit ?? 0) - (d.period_credit ?? 0), 0)

  return {
    revenue: Math.round(revenue * 100) / 100,
    expense: Math.round(expense * 100) / 100,
    profit: Math.round((revenue - expense) * 100) / 100,
    details: rows,
  }
}
