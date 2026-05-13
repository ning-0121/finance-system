/**
 * 真实订单财务闭环验收 — 12 步全链路 E2E
 *
 * 用一张测试订单，跑通：预算单 → 成本项 → 决算 → 应收 → 回款 → 应付 → 付款
 *                       → GL 凭证 → 预算表导出 → 决算表导出 → 异常检测 → 诊断日志
 *
 * 运行: set -a && source .env.local && set +a && npx tsx tests/e2e-full-loop.test.ts
 */
import { createClient } from '@supabase/supabase-js'
import Decimal from 'decimal.js'
import fs from 'fs'
import path from 'path'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!URL || !SVC) { console.error('缺少环境变量'); process.exit(1) }
const svc = createClient(URL, SVC)

// ─── 报告聚合 ─────────────────────────────────────────────
type StepReport = {
  step: number
  name: string
  input: unknown
  write_result: unknown
  read_back: unknown
  formula?: { expected: unknown; actual: unknown }
  pass: boolean
  failure_reason?: string
  fix_suggestion?: string
}
const report: StepReport[] = []
const created: { table: string; id: string }[] = []
function track(table: string, id: string) { created.push({ table, id }) }

function pad(s: string, n: number) { return (s + ' '.repeat(n)).slice(0, n) }
function ok(s: string) { console.log(`  \x1b[32m✓\x1b[0m ${s}`) }
function fail(s: string) { console.log(`  \x1b[31m✗\x1b[0m ${s}`) }

// ─── 固定测试数据 ─────────────────────────────────────────
const TODAY = new Date().toISOString().substring(0, 10) // YYYY-MM-DD
const PERIOD = TODAY.substring(0, 7)                     // YYYY-MM
const TEST_TAG = `E2E-${Date.now()}`

// 业务输入（USD 订单，汇率 7.2）
const ORDER_INPUT = {
  order_no: `${TEST_TAG}-PO`,
  total_revenue_usd: 10000,
  exchange_rate: 7.2,
  currency: 'USD' as const,
  costs: {
    fabric: 30000,      // CNY
    accessory: 5000,
    processing: 8000,
    forwarder: 3000,
    container: 2000,
    logistics: 1500,
  },
  receipt_amount_usd: 9900,  // 客户少付 100 USD（720 CNY）
}

// 衍生预期值（CNY 口径）
const EXPECT = {
  revenue_cny: new Decimal(ORDER_INPUT.total_revenue_usd).mul(ORDER_INPUT.exchange_rate).toNumber(),  // 72000
  total_cost: Object.values(ORDER_INPUT.costs).reduce((s, v) => s + v, 0),                            // 49500
  get profit() { return new Decimal(this.revenue_cny).sub(this.total_cost).toNumber() },              // 22500
  get margin() { return new Decimal(this.profit).div(this.revenue_cny).mul(100).toDecimalPlaces(2).toNumber() }, // 31.25
  receipt_cny: new Decimal(ORDER_INPUT.receipt_amount_usd).mul(ORDER_INPUT.exchange_rate).toNumber(), // 71280
}

// 全局共享
let orderId = ''
let settlementId = ''
let customerId = ''
let actorId = ''
let revenueJournalId = ''
let costJournalId = ''
let receiptJournalId = ''
let paymentJournalId = ''

// ═══════════════════════════════════════════════════════════════
// Step 1: 预算单 (budget_orders.insert)
// ═══════════════════════════════════════════════════════════════
async function step1_budgetOrder() {
  console.log('\n═══ Step 1: 预算单 ═══')
  const { data: cust } = await svc.from('customers').select('id, name').limit(1).maybeSingle()
  if (!cust) {
    report.push({ step:1, name:'预算单', input:ORDER_INPUT, write_result:null, read_back:null, pass:false,
      failure_reason:'customers 表为空', fix_suggestion:'先创建至少一个客户' })
    fail('无客户数据'); return false
  }
  customerId = cust.id

  // 拿一个真实 auth user 作为 created_by（NOT NULL 约束）
  const { data: users } = await svc.auth.admin.listUsers({ perPage: 1 })
  actorId = users?.users?.[0]?.id || ''
  if (!actorId) {
    report.push({ step:1, name:'预算单', input:null, write_result:null, read_back:null, pass:false,
      failure_reason:'auth.users 为空', fix_suggestion:'先创建至少一个用户' })
    fail('无 auth 用户'); return false
  }

  const input = {
    order_no: ORDER_INPUT.order_no,
    customer_id: customerId,
    created_by: actorId,
    order_date: TODAY,
    delivery_date: TODAY,
    items: [{ _cost_breakdown: ORDER_INPUT.costs }],
    target_purchase_price: ORDER_INPUT.costs.fabric,
    estimated_commission: ORDER_INPUT.costs.processing,
    estimated_freight: ORDER_INPUT.costs.forwarder,
    estimated_customs_fee: ORDER_INPUT.costs.container,
    other_costs: ORDER_INPUT.costs.logistics,
    total_revenue: ORDER_INPUT.total_revenue_usd,
    total_cost: EXPECT.total_cost,
    estimated_profit: EXPECT.profit,
    estimated_margin: EXPECT.margin,
    currency: ORDER_INPUT.currency,
    exchange_rate: ORDER_INPUT.exchange_rate,
    status: 'draft',
    notes: TEST_TAG,
  }

  const { data: ins, error: insErr } = await svc.from('budget_orders').insert(input).select('*').single()
  if (insErr || !ins) {
    report.push({ step:1, name:'预算单', input, write_result:{error:insErr?.message}, read_back:null, pass:false,
      failure_reason:insErr?.message || '插入返回空', fix_suggestion:'检查 RLS / 必填字段 / 外键' })
    fail(`插入失败: ${insErr?.message}`); return false
  }
  orderId = ins.id
  track('budget_orders', orderId)

  const { data: rd } = await svc.from('budget_orders').select('*').eq('id', orderId).single()
  const profitOk = Math.abs((rd?.estimated_profit ?? -1) - EXPECT.profit) < 0.01
  const marginOk = Math.abs((rd?.estimated_margin ?? -1) - EXPECT.margin) < 0.01

  report.push({
    step:1, name:'预算单',
    input,
    write_result: { id: orderId, order_no: ins.order_no, status: ins.status },
    read_back: { id: rd?.id, total_revenue: rd?.total_revenue, total_cost: rd?.total_cost, estimated_profit: rd?.estimated_profit, estimated_margin: rd?.estimated_margin, currency: rd?.currency },
    formula: { expected: { profit: EXPECT.profit, margin: EXPECT.margin }, actual: { profit: rd?.estimated_profit, margin: rd?.estimated_margin } },
    pass: profitOk && marginOk,
    failure_reason: profitOk && marginOk ? undefined : '利润/毛利率与预期不符',
  })
  profitOk && marginOk ? ok(`订单 ${ins.order_no} 已创建，profit=${rd?.estimated_profit} margin=${rd?.estimated_margin}%`) : fail('公式不一致')
  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 2: 成本项 (cost_items.insert × 6)
// ═══════════════════════════════════════════════════════════════
async function step2_costItems() {
  console.log('\n═══ Step 2: 成本项 ═══')
  const costTypes: Array<{ type: string; amount: number; desc: string }> = [
    { type: 'fabric',     amount: ORDER_INPUT.costs.fabric,     desc: '面料' },
    { type: 'accessory',  amount: ORDER_INPUT.costs.accessory,  desc: '辅料' },
    { type: 'processing', amount: ORDER_INPUT.costs.processing, desc: '加工费' },
    { type: 'freight',    amount: ORDER_INPUT.costs.forwarder,  desc: '货代' },
    { type: 'container',  amount: ORDER_INPUT.costs.container,  desc: '装柜' },
    { type: 'logistics',  amount: ORDER_INPUT.costs.logistics,  desc: '物流' },
  ]
  const rows = costTypes.map(c => ({
    budget_order_id: orderId,
    cost_type: c.type,
    description: c.desc,
    amount: c.amount,
    currency: 'CNY',
    exchange_rate: 1,
    source_module: 'e2e_test',
    supplier: '测试供应商',
    created_by: actorId,
  }))

  const { data: ins, error: insErr } = await svc.from('cost_items').insert(rows).select('id, cost_type, amount')
  if (insErr) {
    report.push({ step:2, name:'成本项', input:rows, write_result:{error:insErr.message}, read_back:null, pass:false,
      failure_reason: insErr.message, fix_suggestion:'检查 cost_type CHECK 约束允许的值' })
    fail(`插入失败: ${insErr.message}`); return false
  }
  ins?.forEach(r => track('cost_items', r.id))

  const { data: rd } = await svc.from('cost_items').select('cost_type, amount').eq('budget_order_id', orderId).is('deleted_at', null)
  const sum = (rd || []).reduce((s, r) => s + Number(r.amount), 0)
  const sumOk = Math.abs(sum - EXPECT.total_cost) < 0.01

  report.push({
    step:2, name:'成本项',
    input: { count: rows.length, total: EXPECT.total_cost },
    write_result: { inserted: ins?.length, ids: ins?.map(r => r.id) },
    read_back: { count: rd?.length, sum, by_type: rd?.reduce((acc, r) => ({...acc, [r.cost_type]: r.amount}), {}) },
    formula: { expected: EXPECT.total_cost, actual: sum },
    pass: sumOk && rd?.length === 6,
    failure_reason: sumOk ? undefined : `成本汇总 ${sum} ≠ 预期 ${EXPECT.total_cost}`,
  })
  sumOk ? ok(`6 项成本入库，合计 ¥${sum}`) : fail(`合计不符: ${sum}`)
  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 3: 决算单 (order_settlements.insert)
// ═══════════════════════════════════════════════════════════════
async function step3_settlement() {
  console.log('\n═══ Step 3: 决算单 ═══')
  const input = {
    budget_order_id: orderId,
    total_actual: EXPECT.total_cost,  // 实际成本 = 累计 cost_items
    status: 'draft',
  }
  const { data: ins, error: insErr } = await svc.from('order_settlements').insert(input).select('*').single()
  if (insErr || !ins) {
    report.push({ step:3, name:'决算单', input, write_result:{error:insErr?.message}, read_back:null, pass:false,
      failure_reason: insErr?.message, fix_suggestion: '检查 order_settlements 必填字段（可能需要 settlement_no / created_by）' })
    fail(`插入失败: ${insErr?.message}`); return false
  }
  settlementId = ins.id
  track('order_settlements', settlementId)

  // 状态转换：draft → confirmed（验证乐观锁）
  const { data: upd, error: updErr } = await svc.from('order_settlements')
    .update({ status: 'confirmed', settled_at: new Date().toISOString(), settled_by: actorId })
    .eq('id', settlementId).eq('status', 'draft').select('id, status').single()

  const { data: rd } = await svc.from('order_settlements').select('*').eq('id', settlementId).single()

  report.push({
    step:3, name:'决算单',
    input,
    write_result: { id: settlementId, status_after_confirm: upd?.status },
    read_back: { id: rd?.id, status: rd?.status, total_actual: rd?.total_actual, settled_at: rd?.settled_at },
    formula: { expected: { total_actual: EXPECT.total_cost, status: 'confirmed' }, actual: { total_actual: rd?.total_actual, status: rd?.status } },
    pass: rd?.status === 'confirmed' && Math.abs((rd.total_actual ?? -1) - EXPECT.total_cost) < 0.01,
    failure_reason: updErr?.message,
  })
  rd?.status === 'confirmed' ? ok(`决算单 ${settlementId.slice(0,8)} 已确认`) : fail('确认失败')
  return rd?.status === 'confirmed'
}

// ═══════════════════════════════════════════════════════════════
// Step 4: 应收 (budget_orders.ar_received_amount 字段)
// ═══════════════════════════════════════════════════════════════
async function step4_receivable() {
  console.log('\n═══ Step 4: 应收 ═══')
  // 应收即 total_revenue（USD）；前端表 receivables 直接读取 budget_orders
  const { data: rd } = await svc.from('budget_orders')
    .select('id, total_revenue, currency, ar_received_amount, ar_received_at')
    .eq('id', orderId).single()

  const expectedAR = ORDER_INPUT.total_revenue_usd
  const arOk = rd?.total_revenue === expectedAR && rd?.ar_received_amount === null

  report.push({
    step:4, name:'应收',
    input: { order_id: orderId, expected_AR_usd: expectedAR },
    write_result: '(无需写入，应收 = budget_orders.total_revenue)',
    read_back: { total_revenue: rd?.total_revenue, currency: rd?.currency, ar_received_amount: rd?.ar_received_amount, ar_received_at: rd?.ar_received_at },
    formula: { expected: { total_revenue: expectedAR, received: null }, actual: { total_revenue: rd?.total_revenue, received: rd?.ar_received_amount } },
    pass: arOk,
    failure_reason: arOk ? undefined : '应收金额或已收状态异常',
  })
  arOk ? ok(`应收 ${expectedAR} USD（未收）`) : fail('应收状态异常')
  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 5: 回款 (ar_received_amount 写入 + GL 凭证)
// ═══════════════════════════════════════════════════════════════
async function step5_receipt() {
  console.log('\n═══ Step 5: 回款 ═══')
  const input = { order_id: orderId, receipt_usd: ORDER_INPUT.receipt_amount_usd, receipt_cny: EXPECT.receipt_cny }

  // 5.1 写应收已收金额
  const { error: updErr } = await svc.from('budget_orders').update({
    ar_received_amount: ORDER_INPUT.receipt_amount_usd,
    ar_received_at: new Date().toISOString(),
  }).eq('id', orderId)

  if (updErr) {
    report.push({ step:5, name:'回款', input, write_result:{error:updErr.message}, read_back:null, pass:false,
      failure_reason: updErr.message })
    fail(`回款写入失败: ${updErr.message}`); return false
  }

  // 5.2 生成回款 GL 凭证：借 银行存款 / 贷 应收账款
  const { data: rpc, error: rpcErr } = await svc.rpc('create_journal_atomic', {
    p_period_code: PERIOD,
    p_date: TODAY,
    p_description: `回款 ${ORDER_INPUT.order_no}`,
    p_source_type: 'receipt',
    p_source_id: orderId,
    p_total_debit: EXPECT.receipt_cny,
    p_total_credit: EXPECT.receipt_cny,
    p_voucher_type: 'auto',
    p_created_by: actorId,
    p_lines: [
      { account_code: '100201', description: '银行收款', debit: EXPECT.receipt_cny, credit: 0, currency: 'CNY', exchange_rate: 1, order_id: orderId },
      { account_code: '1122',   description: '冲减应收', debit: 0, credit: EXPECT.receipt_cny, currency: 'CNY', exchange_rate: 1, customer_id: customerId, order_id: orderId },
    ],
  })

  if (rpcErr) {
    report.push({ step:5, name:'回款', input, write_result:{error:rpcErr.message}, read_back:null, pass:false,
      failure_reason: rpcErr.message, fix_suggestion: '检查会计期间 / 借贷平衡' })
    fail(`回款凭证失败: ${rpcErr.message}`); return false
  }
  receiptJournalId = (rpc as { journal_id: string }).journal_id
  track('journal_entries', receiptJournalId)

  const { data: rd } = await svc.from('budget_orders').select('ar_received_amount, ar_received_at').eq('id', orderId).single()
  const { data: lines } = await svc.from('journal_lines').select('account_code, debit, credit').eq('journal_id', receiptJournalId).order('line_no')
  const debitOk = Math.abs((lines?.find(l => l.account_code === '100201')?.debit ?? 0) - EXPECT.receipt_cny) < 0.01
  const creditOk = Math.abs((lines?.find(l => l.account_code === '1122')?.credit ?? 0) - EXPECT.receipt_cny) < 0.01

  report.push({
    step:5, name:'回款',
    input,
    write_result: { ar_updated: !updErr, journal_id: receiptJournalId, voucher_no: (rpc as { voucher_no: string }).voucher_no },
    read_back: { ar_received_amount: rd?.ar_received_amount, ar_received_at: rd?.ar_received_at, lines },
    formula: { expected: { debit_100201: EXPECT.receipt_cny, credit_1122: EXPECT.receipt_cny }, actual: { debit_100201: lines?.find(l => l.account_code === '100201')?.debit, credit_1122: lines?.find(l => l.account_code === '1122')?.credit } },
    pass: debitOk && creditOk && rd?.ar_received_amount === ORDER_INPUT.receipt_amount_usd,
    failure_reason: debitOk && creditOk ? undefined : '凭证借贷与预期不符',
  })
  ok(`回款 ${ORDER_INPUT.receipt_amount_usd} USD（CNY ${EXPECT.receipt_cny}），凭证 ${(rpc as { voucher_no: string }).voucher_no}`)
  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 6: 应付 (payable_records.insert)
// ═══════════════════════════════════════════════════════════════
async function step6_payable() {
  console.log('\n═══ Step 6: 应付 ═══')
  // 简化场景：直接为每个成本类目生成一条应付（不走 actual_invoices）
  const rows = [
    { cost_category: 'raw_material', supplier_name: '面料供应商A', amount: ORDER_INPUT.costs.fabric, description: '面料' },
    { cost_category: 'raw_material', supplier_name: '辅料供应商B', amount: ORDER_INPUT.costs.accessory, description: '辅料' },
    { cost_category: 'factory',      supplier_name: '加工厂C',     amount: ORDER_INPUT.costs.processing, description: '加工' },
    { cost_category: 'freight',      supplier_name: '货代D',       amount: ORDER_INPUT.costs.forwarder, description: '货代' },
  ].map(r => ({
    ...r,
    budget_order_id: orderId,
    settlement_id: settlementId,
    order_no: ORDER_INPUT.order_no,
    currency: 'CNY',
    payment_status: 'unpaid',
    over_budget: false,
  }))

  const { data: ins, error: insErr } = await svc.from('payable_records').insert(rows).select('id, supplier_name, amount, payment_status')
  if (insErr) {
    report.push({ step:6, name:'应付', input:rows, write_result:{error:insErr.message}, read_back:null, pass:false,
      failure_reason: insErr.message, fix_suggestion: 'invoice_id 可能必填；可考虑改为 nullable 或先创建 actual_invoice' })
    fail(`应付插入失败: ${insErr.message}`); return false
  }
  ins?.forEach(r => track('payable_records', r.id))

  const { data: rd } = await svc.from('payable_records').select('amount, payment_status').eq('budget_order_id', orderId)
  const sum = (rd || []).reduce((s, r) => s + Number(r.amount), 0)
  const expectedSum = rows.reduce((s, r) => s + r.amount, 0)
  const sumOk = Math.abs(sum - expectedSum) < 0.01

  report.push({
    step:6, name:'应付',
    input: { count: rows.length, total: expectedSum },
    write_result: { inserted: ins?.length, records: ins },
    read_back: { count: rd?.length, sum, all_unpaid: rd?.every(r => r.payment_status === 'unpaid') },
    formula: { expected: expectedSum, actual: sum },
    pass: sumOk && rd?.every(r => r.payment_status === 'unpaid'),
  })
  ok(`${rows.length} 条应付入库，合计 ¥${sum}`)
  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 7: 付款 (payable_records.update payment_status='paid' + GL)
// ═══════════════════════════════════════════════════════════════
async function step7_payment() {
  console.log('\n═══ Step 7: 付款 ═══')
  const { data: aps } = await svc.from('payable_records').select('id, amount').eq('budget_order_id', orderId)
  if (!aps?.length) {
    report.push({ step:7, name:'付款', input:null, write_result:null, read_back:null, pass:false, failure_reason:'无应付记录' })
    return false
  }
  // 只付第一笔 — 状态机要求: unpaid → pending_approval → approved → paid
  const first = aps[0]
  const trans: Array<{ to: string; extra?: Record<string, unknown> }> = [
    { to: 'pending_approval' },
    { to: 'approved', extra: { approved_at: new Date().toISOString() } },
    { to: 'paid', extra: { paid_amount: first.amount, paid_at: new Date().toISOString(), payment_method: 'bank_transfer' } },
  ]
  for (const t of trans) {
    const { error: stepErr } = await svc.from('payable_records')
      .update({ payment_status: t.to, ...(t.extra || {}) })
      .eq('id', first.id)
    if (stepErr) {
      report.push({ step:7, name:'付款', input:{ id:first.id, target:t.to }, write_result:{error:stepErr.message}, read_back:null, pass:false, failure_reason: stepErr.message, fix_suggestion: '检查状态机触发器允许的转换' })
      fail(`付款转到 ${t.to} 失败: ${stepErr.message}`); return false
    }
  }

  // 付款凭证：借 应付账款 / 贷 银行存款
  const { data: rpc, error: rpcErr } = await svc.rpc('create_journal_atomic', {
    p_period_code: PERIOD, p_date: TODAY,
    p_description: `付款 ${ORDER_INPUT.order_no} 面料供应商A`,
    p_source_type: 'payment', p_source_id: first.id,
    p_total_debit: first.amount, p_total_credit: first.amount,
    p_voucher_type: 'auto', p_created_by: actorId,
    p_lines: [
      { account_code: '2202',   description: '冲减应付', debit: first.amount, credit: 0, currency: 'CNY', exchange_rate: 1, supplier_name: '面料供应商A', order_id: orderId },
      { account_code: '100201', description: '银行付款', debit: 0, credit: first.amount, currency: 'CNY', exchange_rate: 1, order_id: orderId },
    ],
  })
  if (rpcErr) {
    report.push({ step:7, name:'付款', input:{ id:first.id }, write_result:{error:rpcErr.message}, read_back:null, pass:false, failure_reason: rpcErr.message })
    fail(`付款凭证失败: ${rpcErr.message}`); return false
  }
  paymentJournalId = (rpc as { journal_id: string }).journal_id
  track('journal_entries', paymentJournalId)

  const { data: rd } = await svc.from('payable_records').select('payment_status, paid_amount').eq('id', first.id).single()
  const { data: lines } = await svc.from('journal_lines').select('account_code, debit, credit').eq('journal_id', paymentJournalId)

  report.push({
    step:7, name:'付款',
    input: { record_id: first.id, amount: first.amount },
    write_result: { status: rd?.payment_status, voucher_no: (rpc as { voucher_no: string }).voucher_no },
    read_back: { payment_status: rd?.payment_status, paid_amount: rd?.paid_amount, gl_lines: lines },
    formula: { expected: { debit_2202: first.amount, credit_100201: first.amount }, actual: { debit_2202: lines?.find(l => l.account_code === '2202')?.debit, credit_100201: lines?.find(l => l.account_code === '100201')?.credit } },
    pass: rd?.payment_status === 'paid',
  })
  ok(`付款 ¥${first.amount} 完成，凭证 ${(rpc as { voucher_no: string }).voucher_no}`)
  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 8: GL 凭证（确认收入 + 结转成本）
// ═══════════════════════════════════════════════════════════════
async function step8_glVouchers() {
  console.log('\n═══ Step 8: GL 凭证（收入 / 成本）═══')
  // 8.1 收入确认凭证：借 应收账款 / 贷 主营业务收入-外销（USD 换算 CNY）
  const { data: revRpc, error: revErr } = await svc.rpc('create_journal_atomic', {
    p_period_code: PERIOD, p_date: TODAY,
    p_description: `确认收入 ${ORDER_INPUT.order_no}`,
    p_source_type: 'budget_order', p_source_id: orderId,
    p_total_debit: EXPECT.revenue_cny, p_total_credit: EXPECT.revenue_cny,
    p_voucher_type: 'auto', p_created_by: actorId,
    p_lines: [
      { account_code: '1122', description: '应收-客户', debit: EXPECT.revenue_cny, credit: 0, currency: 'USD', exchange_rate: ORDER_INPUT.exchange_rate, original_amount: ORDER_INPUT.total_revenue_usd, customer_id: customerId, order_id: orderId },
      { account_code: '500101', description: '外销收入', debit: 0, credit: EXPECT.revenue_cny, currency: 'USD', exchange_rate: ORDER_INPUT.exchange_rate, original_amount: ORDER_INPUT.total_revenue_usd, order_id: orderId },
    ],
  })
  if (revErr) {
    report.push({ step:8, name:'GL 收入凭证', input:null, write_result:{error:revErr.message}, read_back:null, pass:false, failure_reason: revErr.message })
    fail(`收入凭证失败: ${revErr.message}`); return false
  }
  revenueJournalId = (revRpc as { journal_id: string }).journal_id
  track('journal_entries', revenueJournalId)

  // 8.2 成本结转凭证：借 各成本科目 / 贷 应付账款
  const costLines = [
    { account_code: '540101', description: '面料成本',   debit: ORDER_INPUT.costs.fabric,     credit: 0, currency: 'CNY', exchange_rate: 1, order_id: orderId },
    { account_code: '540102', description: '辅料成本',   debit: ORDER_INPUT.costs.accessory,  credit: 0, currency: 'CNY', exchange_rate: 1, order_id: orderId },
    { account_code: '540103', description: '加工费',     debit: ORDER_INPUT.costs.processing, credit: 0, currency: 'CNY', exchange_rate: 1, order_id: orderId },
    { account_code: '540201', description: '货代费',     debit: ORDER_INPUT.costs.forwarder,  credit: 0, currency: 'CNY', exchange_rate: 1, order_id: orderId },
    { account_code: '2202',   description: '应付-成本',  debit: 0, credit: EXPECT.total_cost - ORDER_INPUT.costs.container - ORDER_INPUT.costs.logistics, currency: 'CNY', exchange_rate: 1, order_id: orderId },
  ]
  // 简化为前 4 项 + 应付 平衡
  const debitSum = costLines.slice(0, 4).reduce((s, l) => s + l.debit, 0)
  costLines[4].credit = debitSum

  const { data: costRpc, error: costErr } = await svc.rpc('create_journal_atomic', {
    p_period_code: PERIOD, p_date: TODAY,
    p_description: `结转成本 ${ORDER_INPUT.order_no}`,
    p_source_type: 'settlement', p_source_id: settlementId,
    p_total_debit: debitSum, p_total_credit: debitSum,
    p_voucher_type: 'auto', p_created_by: actorId,
    p_lines: costLines,
  })
  if (costErr) {
    report.push({ step:8, name:'GL 成本凭证', input:null, write_result:{error:costErr.message}, read_back:null, pass:false, failure_reason: costErr.message })
    fail(`成本凭证失败: ${costErr.message}`); return false
  }
  costJournalId = (costRpc as { journal_id: string }).journal_id
  track('journal_entries', costJournalId)

  // 回读两张凭证 + 借贷平衡校验
  const { data: revEntry } = await svc.from('journal_entries').select('voucher_no, total_debit, total_credit, status').eq('id', revenueJournalId).single()
  const { data: costEntry } = await svc.from('journal_entries').select('voucher_no, total_debit, total_credit, status').eq('id', costJournalId).single()
  const revBalanced = revEntry && Math.abs((revEntry.total_debit ?? 0) - (revEntry.total_credit ?? 0)) < 0.01
  const costBalanced = costEntry && Math.abs((costEntry.total_debit ?? 0) - (costEntry.total_credit ?? 0)) < 0.01

  report.push({
    step:8, name:'GL 凭证（收入+成本）',
    input: { revenue_cny: EXPECT.revenue_cny, cost_cny: debitSum },
    write_result: { revenue_voucher: revEntry?.voucher_no, cost_voucher: costEntry?.voucher_no },
    read_back: { revenue: revEntry, cost: costEntry },
    formula: { expected: { balanced: true }, actual: { revBalanced, costBalanced } },
    pass: !!(revBalanced && costBalanced && revEntry?.status === 'posted' && costEntry?.status === 'posted'),
  })
  ok(`收入凭证 ${revEntry?.voucher_no}（借/贷 ¥${EXPECT.revenue_cny}）`)
  ok(`成本凭证 ${costEntry?.voucher_no}（借/贷 ¥${debitSum}）`)
  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 9 & 10: 预算表 / 决算表 Excel 导出
// ═══════════════════════════════════════════════════════════════
async function step9and10_exports() {
  console.log('\n═══ Step 9-10: Excel 导出（预算/决算）═══')
  // 不能在 Node 直接调 XLSX writeFile（浏览器 API），改为校验导出器的纯函数 buildExportRows
  const { buildExportRows, synthesizeCostItems, computeFinancials } = await import('@/lib/excel/export-budget-sheet').catch(() =>
    import(path.resolve('src/lib/excel/export-budget-sheet.ts'))
  ) as typeof import('../src/lib/excel/export-budget-sheet')

  const { data: order } = await svc.from('budget_orders').select('*, customer:customers(id, company:name)').eq('id', orderId).single()
  if (!order) {
    report.push({ step:9, name:'预算表导出', input:null, write_result:null, read_back:null, pass:false, failure_reason:'订单读取失败' })
    return false
  }

  // 9. 预算表
  const synth = synthesizeCostItems(order as Parameters<typeof synthesizeCostItems>[0])
  const budgetOut = buildExportRows(order as Parameters<typeof buildExportRows>[0], synth, 'budget', 'actual', TODAY)
  const fin = budgetOut.financials
  const finExpect = computeFinancials(ORDER_INPUT.total_revenue_usd, EXPECT.total_cost, ORDER_INPUT.exchange_rate, false)
  const budgetOk = Math.abs(fin.revenueCNY - EXPECT.revenue_cny) < 0.01
                && Math.abs(fin.totalCost - EXPECT.total_cost) < 0.01
                && Math.abs(fin.profit - EXPECT.profit) < 0.01
                && Math.abs(fin.margin - EXPECT.margin) < 0.01

  report.push({
    step:9, name:'预算表导出',
    input: { order_id: orderId, type:'budget' },
    write_result: { rows: budgetOut.rows.length, hasWarning: budgetOut.rows.some(r => r.some(c => String(c||'').includes('预算成本估算'))) },
    read_back: { financials: fin, sample_rows: budgetOut.rows.slice(0,3) },
    formula: { expected: { revenueCNY: EXPECT.revenue_cny, profit: EXPECT.profit, margin: EXPECT.margin }, actual: fin },
    pass: budgetOk,
    failure_reason: budgetOk ? undefined : 'computeFinancials 与预期不一致',
  })
  ok(`预算表 ${budgetOut.rows.length} 行，CNY收入 ¥${fin.revenueCNY} 成本 ¥${fin.totalCost} 利润 ¥${fin.profit} 毛利率 ${fin.margin}%`)

  // 10. 决算表（estimated 触发警示行）
  const settleOut = buildExportRows(order as Parameters<typeof buildExportRows>[0], synth, 'settlement', 'estimated', TODAY)
  const hasWarn = settleOut.rows.some(r => r.some(c => String(c||'').includes('预算成本估算')))
  const settleOk = Math.abs(settleOut.financials.profit - EXPECT.profit) < 0.01 && hasWarn

  report.push({
    step:10, name:'决算表导出',
    input: { order_id: orderId, type:'settlement', costSource:'estimated' },
    write_result: { rows: settleOut.rows.length, hasFallbackWarning: hasWarn },
    read_back: { financials: settleOut.financials },
    formula: { expected: { profit: EXPECT.profit, hasWarning: true }, actual: { profit: settleOut.financials.profit, hasWarning: hasWarn } },
    pass: settleOk,
  })
  ok(`决算表 ${settleOut.rows.length} 行，警示行=${hasWarn}，利润 ¥${settleOut.financials.profit}`)

  // 同时校验独立纯函数 computeFinancials
  const cfOk = JSON.stringify(fin) === JSON.stringify(finExpect)
  if (!cfOk) console.log('  ⚠ computeFinancials 与 buildExportRows 内部计算不一致:', { fin, finExpect })

  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 11: 异常检测 (financial_risk_events.insert)
// ═══════════════════════════════════════════════════════════════
async function step11_riskEvent() {
  console.log('\n═══ Step 11: 异常检测 ═══')
  // 检测：客户少付 100 USD → bad_debt_risk / 应使用 overdue_payment 或 low_profit_order
  const { data: order } = await svc.from('budget_orders').select('total_revenue, ar_received_amount').eq('id', orderId).single()
  const shortfall = (order?.total_revenue || 0) - (order?.ar_received_amount || 0)

  const input = {
    risk_type: 'overdue_payment',
    risk_level: shortfall > 0 ? 'yellow' : 'green',
    related_order_id: orderId,
    related_customer_id: customerId,
    title: `${ORDER_INPUT.order_no} 客户少付 ${shortfall} USD`,
    description: `应收 ${order?.total_revenue} USD，实收 ${order?.ar_received_amount} USD，差额 ${shortfall} USD`,
    suggested_action: '请财务跟进核销或催收',
    status: 'pending',
  }
  const { data: ins, error: insErr } = await svc.from('financial_risk_events').insert(input).select('*').single()
  if (insErr || !ins) {
    report.push({ step:11, name:'异常检测', input, write_result:{error:insErr?.message}, read_back:null, pass:false, failure_reason: insErr?.message })
    fail(`风险事件插入失败: ${insErr?.message}`); return false
  }
  track('financial_risk_events', ins.id)

  const { data: rd } = await svc.from('financial_risk_events').select('*').eq('id', ins.id).single()
  const detectOk = shortfall === 100 && rd?.risk_level === 'yellow' && rd?.status === 'pending'

  report.push({
    step:11, name:'异常检测',
    input,
    write_result: { id: ins.id, risk_type: ins.risk_type, risk_level: ins.risk_level },
    read_back: { id: rd?.id, status: rd?.status, title: rd?.title, related_order_id: rd?.related_order_id },
    formula: { expected: { shortfall_usd: 100, risk_level: 'yellow' }, actual: { shortfall_usd: shortfall, risk_level: rd?.risk_level } },
    pass: detectOk,
  })
  ok(`风险事件登记：${rd?.title}`)
  return true
}

// ═══════════════════════════════════════════════════════════════
// Step 12: 诊断日志 (save_diagnostic_logs.insert)
// ═══════════════════════════════════════════════════════════════
async function step12_diagnosticLog() {
  console.log('\n═══ Step 12: 诊断日志 ═══')
  const input = {
    action: 'insert',
    table_name: 'budget_orders',
    record_id: orderId,
    actor_id: null,
    source_page: 'e2e-test',
    api_route: null,
    payload_hash: 'e2e-payload-hash',
    db_hash: 'e2e-db-hash',
    status: 'ok',
    error_detail: null,
  }
  const { data: ins, error: insErr } = await svc.from('save_diagnostic_logs').insert(input).select('*').single()
  if (insErr || !ins) {
    report.push({ step:12, name:'诊断日志', input, write_result:{error:insErr?.message}, read_back:null, pass:false, failure_reason: insErr?.message })
    fail(`诊断日志失败: ${insErr?.message}`); return false
  }
  track('save_diagnostic_logs', ins.id)

  const { data: rd } = await svc.from('save_diagnostic_logs').select('*').eq('id', ins.id).single()
  report.push({
    step:12, name:'诊断日志',
    input,
    write_result: { id: ins.id, status: ins.status },
    read_back: { id: rd?.id, table_name: rd?.table_name, status: rd?.status, action: rd?.action, record_id: rd?.record_id },
    formula: { expected: { status: 'ok', record_id: orderId }, actual: { status: rd?.status, record_id: rd?.record_id } },
    pass: rd?.status === 'ok' && rd?.record_id === orderId,
  })
  ok(`诊断日志 ${ins.id.slice(0,8)} 已持久化`)
  return true
}

// ═══════════════════════════════════════════════════════════════
// 清理
// ═══════════════════════════════════════════════════════════════
async function cleanup() {
  console.log('\n═══ 清理测试数据 ═══')
  // 先删 journal_lines（无 id 跟踪，通过 journal_id 删）
  for (const jid of [revenueJournalId, costJournalId, receiptJournalId, paymentJournalId].filter(Boolean)) {
    await svc.from('journal_lines').delete().eq('journal_id', jid)
  }
  // 倒序删除有 id 的记录
  for (const { table, id } of [...created].reverse()) {
    const { error } = await svc.from(table).delete().eq('id', id)
    if (error) console.log(`  ⚠ 删除 ${table}/${id.slice(0,8)}: ${error.message}`)
  }
  console.log(`  已清理 ${created.length} 条记录`)
}

// ═══════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('╔════════════════════════════════════════════╗')
  console.log('║  真实订单财务闭环验收 — 12 步全链路 E2E   ║')
  console.log('╚════════════════════════════════════════════╝')
  console.log(`期间=${PERIOD} 订单号=${ORDER_INPUT.order_no} 汇率=${ORDER_INPUT.exchange_rate}`)
  console.log(`预期: 收入 ¥${EXPECT.revenue_cny} 成本 ¥${EXPECT.total_cost} 利润 ¥${EXPECT.profit} 毛利率 ${EXPECT.margin}%`)

  const steps: Array<[string, () => Promise<boolean>]> = [
    ['Step 1', step1_budgetOrder],
    ['Step 2', step2_costItems],
    ['Step 3', step3_settlement],
    ['Step 4', step4_receivable],
    ['Step 5', step5_receipt],
    ['Step 6', step6_payable],
    ['Step 7', step7_payment],
    ['Step 8', step8_glVouchers],
    ['Step 9/10', step9and10_exports],
    ['Step 11', step11_riskEvent],
    ['Step 12', step12_diagnosticLog],
  ]

  for (const [, fn] of steps) {
    try { await fn() } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`  💥 未捕获异常: ${msg}`)
      report.push({ step: report.length+1, name:'(异常)', input:null, write_result:null, read_back:null, pass:false, failure_reason: msg })
    }
  }

  // 写报告
  const outPath = path.resolve('tests/e2e-full-loop-report.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

  console.log('\n╔════════════════════════════════════════════╗')
  console.log('║  验收汇总                                  ║')
  console.log('╚════════════════════════════════════════════╝')
  for (const r of report) {
    const flag = r.pass ? '\x1b[32m✓ PASS\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'
    console.log(`${flag}  ${pad('Step '+r.step, 8)} ${r.name}${r.failure_reason ? ' — '+r.failure_reason : ''}`)
  }
  const passed = report.filter(r => r.pass).length
  console.log(`\n总计: ${passed}/${report.length} 通过　报告: ${outPath}`)

  await cleanup()
  process.exit(passed === report.length ? 0 : 1)
}

main().catch(e => { console.error(e); cleanup().finally(() => process.exit(1)) })
