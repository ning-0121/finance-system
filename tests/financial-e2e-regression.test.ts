/**
 * 财务系统端到端回归测试
 * 覆盖审计要求的 8 个核心场景
 *
 * 运行: npx tsx tests/financial-e2e-regression.test.ts
 *
 * 需要环境变量:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY
 */

import { createClient } from '@supabase/supabase-js'
import Decimal from 'decimal.js'

const URL      = process.env.NEXT_PUBLIC_SUPABASE_URL       || ''
const SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY      || ''
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY  || ''

if (!URL || !SVC_KEY || !ANON_KEY) {
  console.error('缺少环境变量')
  process.exit(1)
}

const svc  = createClient(URL, SVC_KEY)
const anon = createClient(URL, ANON_KEY)

let passed = 0
let failed = 0
const failures: string[] = []
const created: { table: string; id: string }[] = []

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else           { failed++; failures.push(msg); console.error(`  ✗ ${msg}`) }
}

async function cleanup() {
  for (const { table, id } of created.reverse()) {
    try { await svc.from(table).delete().eq('id', id) } catch { /* ignore */ }
  }
}

// ─── 前置：获取 profile + customer ───

async function getFixtures() {
  const { data: profiles } = await svc.from('profiles').select('id').limit(1)
  const { data: customers } = await svc.from('customers').select('id').limit(1)
  const profileId  = profiles?.[0]?.id  as string | undefined
  const customerId = customers?.[0]?.id as string | undefined
  if (!profileId || !customerId) throw new Error('测试数据不足：需要至少 1 个 profile 和 1 个 customer')
  return { profileId, customerId }
}

// ═══════════════════════════════════════════════════════════
// 场景 1: 创建预算单 → 保存 → re-read → 页面可见
// ═══════════════════════════════════════════════════════════
async function scene1_BudgetOrderCreateAndRead() {
  console.log('\n─── 场景1: 创建预算单 → 保存 → re-read → 可见 ───')
  const { profileId, customerId } = await getFixtures()

  const payload = {
    order_no:         `E2E-S1-${Date.now()}`,
    customer_id:      customerId,
    total_revenue:    50000,
    total_cost:       40000,
    estimated_profit: 10000,
    estimated_margin: 20,
    currency:         'USD',
    exchange_rate:    7.15,
    status:           'draft',
    created_by:       profileId,
    order_date:       '2026-05-01',
  }

  const { data: ins, error: insErr } = await svc.from('budget_orders').insert(payload).select().single()
  assert(!insErr, `INSERT 无错误 (${insErr?.message ?? 'ok'})`)
  assert(!!ins?.id, `返回 ID`)
  if (!ins) return
  created.push({ table: 'budget_orders', id: ins.id })

  // anon key 回读（模拟前端）
  const { data: rd } = await anon.from('budget_orders').select('*').eq('id', ins.id).single()
  assert(!!rd, 'ANON 回读非空')
  assert(rd?.total_revenue === 50000, `收入一致: ${rd?.total_revenue}`)
  assert(rd?.total_cost   === 40000, `成本一致: ${rd?.total_cost}`)
  assert(rd?.exchange_rate === 7.15, `汇率一致: ${rd?.exchange_rate}`)

  // 利润公式校验
  const profit = new Decimal(rd?.total_revenue ?? 0).minus(rd?.total_cost ?? 0)
  assert(profit.toNumber() === rd?.estimated_profit, `利润 = 收入 - 成本: ${profit.toNumber()} vs ${rd?.estimated_profit}`)

  // 毛利率公式校验（误差 < 0.01%）
  const margin = profit.div(rd?.total_revenue ?? 1).mul(100)
  assert(Math.abs(margin.toNumber() - (rd?.estimated_margin ?? 0)) < 0.01, `毛利率公式正确: ${margin.toFixed(2)}%`)
}

// ═══════════════════════════════════════════════════════════
// 场景 2: 编辑预算单 → 保存 → 页面刷新 → 数据仍存在
// ═══════════════════════════════════════════════════════════
async function scene2_BudgetOrderEditPersistence() {
  console.log('\n─── 场景2: 编辑预算单 → 保存 → 刷新 → 数据仍在 ───')
  const { profileId, customerId } = await getFixtures()

  const { data: ins } = await svc.from('budget_orders').insert({
    order_no: `E2E-S2-${Date.now()}`, customer_id: customerId,
    total_revenue: 30000, total_cost: 25000, estimated_profit: 5000,
    estimated_margin: 16.67, currency: 'USD', exchange_rate: 7.2,
    status: 'draft', created_by: profileId, order_date: '2026-05-02',
  }).select().single()
  if (!ins) { assert(false, '场景2 INSERT 失败'); return }
  created.push({ table: 'budget_orders', id: ins.id })

  // 模拟编辑：更新成本
  const { error: updErr } = await svc.from('budget_orders')
    .update({ total_cost: 22000, estimated_profit: 8000, estimated_margin: 26.67 })
    .eq('id', ins.id)
  assert(!updErr, `UPDATE 无错误 (${updErr?.message ?? 'ok'})`)

  // 模拟刷新：anon 重新读取
  const { data: refreshed } = await anon.from('budget_orders').select('*').eq('id', ins.id).single()
  assert(refreshed?.total_cost === 22000, `刷新后成本更新: ${refreshed?.total_cost}`)
  assert(refreshed?.estimated_profit === 8000, `刷新后利润更新: ${refreshed?.estimated_profit}`)
}

// ═══════════════════════════════════════════════════════════
// 场景 3: 上传供应商发票 → 创建付款申请 → 状态检查
// ═══════════════════════════════════════════════════════════
async function scene3_SupplierInvoiceToPaymentRequest() {
  console.log('\n─── 场景3: 供应商发票 → 付款申请 → 状态 ───')
  const { profileId, customerId } = await getFixtures()

  // 先创建依赖的预算单
  const { data: order } = await svc.from('budget_orders').insert({
    order_no: `E2E-S3-${Date.now()}`, customer_id: customerId,
    total_revenue: 20000, currency: 'USD', exchange_rate: 7,
    status: 'approved', created_by: profileId, order_date: '2026-05-03',
  }).select().single()
  if (!order) { assert(false, '场景3 预算单 INSERT 失败'); return }
  created.push({ table: 'budget_orders', id: order.id })

  const invNo = `INV-E2E-S3-${Date.now()}`
  const { data: inv, error: invErr } = await svc.from('actual_invoices').insert({
    budget_order_id: order.id,
    invoice_type:    'supplier_invoice',
    invoice_no:      invNo,
    supplier_name:   '测试供应商',
    total_amount:    5000,
    currency:        'CNY',
    exchange_rate:   1,
    status:          'pending',
    created_by:      profileId,
  }).select().single()
  assert(!invErr, `付款申请 INSERT 无错误 (${invErr?.message ?? 'ok'})`)
  assert(!!inv?.id, '返回 ID')
  if (!inv) return
  created.push({ table: 'actual_invoices', id: inv.id })

  // 状态检查
  assert(inv.status === 'pending', `初始状态为 pending: ${inv.status}`)

  // 审批通过
  const { error: apvErr } = await svc.from('actual_invoices').update({ status: 'approved' }).eq('id', inv.id)
  assert(!apvErr, `审批更新无错误 (${apvErr?.message ?? 'ok'})`)

  const { data: rd } = await anon.from('actual_invoices').select('status').eq('id', inv.id).single()
  assert(rd?.status === 'approved', `审批后状态为 approved: ${rd?.status}`)
}

// ═══════════════════════════════════════════════════════════
// 场景 4: 银行回单 → 创建回款 → 应收状态更新
// ═══════════════════════════════════════════════════════════
async function scene4_BankReceiptToAR() {
  console.log('\n─── 场景4: 银行回单 → 回款 → 应收更新 ───')
  const { profileId, customerId } = await getFixtures()

  const { data: order } = await svc.from('budget_orders').insert({
    order_no:          `E2E-S4-${Date.now()}`,
    customer_id:       customerId,
    total_revenue:     10000,
    currency:          'USD',
    exchange_rate:     7.1,
    status:            'approved',
    created_by:        profileId,
    order_date:        '2026-05-04',
    ar_received_amount: null,
  }).select().single()
  if (!order) { assert(false, '场景4 预算单 INSERT 失败'); return }
  created.push({ table: 'budget_orders', id: order.id })

  // 记录回款
  const { error: recErr } = await svc.from('budget_orders')
    .update({ ar_received_amount: 10000, ar_received_at: new Date().toISOString() })
    .eq('id', order.id)
  assert(!recErr, `记录回款无错误 (${recErr?.message ?? 'ok'})`)

  const { data: rd } = await anon.from('budget_orders')
    .select('ar_received_amount, ar_received_at')
    .eq('id', order.id).single()
  assert(rd?.ar_received_amount === 10000, `回款金额写入: ${rd?.ar_received_amount}`)
  assert(!!rd?.ar_received_at,             `回款时间写入: ${rd?.ar_received_at}`)
}

// ═══════════════════════════════════════════════════════════
// 场景 5: 创建凭证 → 借贷平衡校验 → 保存
// ═══════════════════════════════════════════════════════════
async function scene5_VoucherBalanceCheck() {
  console.log('\n─── 场景5: 凭证 → 借贷平衡校验 → 保存 ───')
  const { profileId } = await getFixtures()

  // 确保期间存在
  const periodCode = '2026-05'
  const { data: period } = await svc.from('accounting_periods').select('status').eq('period_code', periodCode).maybeSingle()
  if (!period) {
    await svc.from('accounting_periods').insert({
      period_code: periodCode, year: 2026, month: 5,
      start_date: '2026-05-01', end_date: '2026-05-31',
    })
  }

  // 不平衡凭证 → 应被拒绝（DB check constraint）
  const { error: badErr } = await svc.from('journal_entries').insert({
    voucher_no: `BAD-E2E-${Date.now()}`, period_code: periodCode,
    voucher_date: '2026-05-01', description: '不平衡测试',
    total_debit: 1000, total_credit: 999, status: 'draft', created_by: profileId,
  })
  assert(!!badErr, `不平衡凭证被拒绝 (${badErr?.message?.slice(0, 60) ?? 'NO ERROR'})`)

  // 平衡凭证 → 应成功
  const voucherNo = `OK-E2E-${Date.now()}`
  const { data: good, error: goodErr } = await svc.from('journal_entries').insert({
    voucher_no: voucherNo, period_code: periodCode,
    voucher_date: '2026-05-01', description: '平衡测试凭证',
    total_debit: 1000, total_credit: 1000, status: 'draft', created_by: profileId,
  }).select().single()
  assert(!goodErr, `平衡凭证保存成功 (${goodErr?.message ?? 'ok'})`)
  if (good) created.push({ table: 'journal_entries', id: good.id })
}

// ═══════════════════════════════════════════════════════════
// 场景 6: 状态机非法转换 hard fail
// ═══════════════════════════════════════════════════════════
async function scene6_StateMachineHardFail() {
  console.log('\n─── 场景6: 状态机非法转换 hard fail ───')
  const { profileId, customerId } = await getFixtures()

  const { data: order } = await svc.from('budget_orders').insert({
    order_no: `E2E-S6-${Date.now()}`, customer_id: customerId,
    total_revenue: 5000, currency: 'USD', exchange_rate: 7,
    status: 'draft', created_by: profileId, order_date: '2026-05-06',
  }).select().single()
  if (!order) { assert(false, '场景6 预算单 INSERT 失败'); return }
  created.push({ table: 'budget_orders', id: order.id })

  // draft → approved：合法（经过 pending_review）
  await svc.from('budget_orders').update({ status: 'pending_review' }).eq('id', order.id)
  await svc.from('budget_orders').update({ status: 'approved' }).eq('id', order.id)
  await svc.from('budget_orders').update({ status: 'closed' }).eq('id', order.id)

  // closed → draft：非法，应报错
  const { error: illegalErr } = await svc.from('budget_orders').update({ status: 'draft' }).eq('id', order.id)
  assert(!!illegalErr, `closed→draft 被拒绝 (${illegalErr?.message?.slice(0, 60) ?? 'NO ERROR'})`)

  // 验证状态仍为 closed
  const { data: rd } = await svc.from('budget_orders').select('status').eq('id', order.id).single()
  assert(rd?.status === 'closed', `状态未被污染，仍为 closed: ${rd?.status}`)
}

// ═══════════════════════════════════════════════════════════
// 场景 7: 应收/应付互相印证
// ═══════════════════════════════════════════════════════════
async function scene7_ARAPCrossValidation() {
  console.log('\n─── 场景7: 应收/应付互相印证 ───')
  const { profileId, customerId } = await getFixtures()

  const { data: order } = await svc.from('budget_orders').insert({
    order_no:         `E2E-S7-${Date.now()}`,
    customer_id:      customerId,
    total_revenue:    15000,
    total_cost:       12000,
    estimated_profit: 3000,
    estimated_margin: 20,
    currency:         'USD',
    exchange_rate:    7.05,
    status:           'approved',
    created_by:       profileId,
    order_date:       '2026-05-07',
  }).select().single()
  if (!order) { assert(false, '场景7 预算单 INSERT 失败'); return }
  created.push({ table: 'budget_orders', id: order.id })

  // 校验：利润 = 收入 - 成本
  const profit = new Decimal(order.total_revenue ?? 0).minus(order.total_cost ?? 0)
  const marginCalc = profit.div(order.total_revenue ?? 1).mul(100)
  assert(Math.abs(profit.toNumber() - (order.estimated_profit ?? 0)) < 0.01,
    `利润互相印证: ${profit.toNumber()} vs ${order.estimated_profit}`)
  assert(Math.abs(marginCalc.toNumber() - (order.estimated_margin ?? 0)) < 0.01,
    `毛利率互相印证: ${marginCalc.toFixed(2)}% vs ${order.estimated_margin}%`)

  // 成本项归集
  const { data: costItem, error: costErr } = await svc.from('cost_items').insert({
    budget_order_id: order.id,
    cost_type:       'freight',
    description:     '场景7测试运费',
    amount:          500,
    currency:        'USD',
    exchange_rate:   7.05,
    created_by:      profileId,
  }).select().single()
  assert(!costErr, `成本项保存无错误 (${costErr?.message ?? 'ok'})`)
  if (costItem) created.push({ table: 'cost_items', id: costItem.id })

  // 负金额拒绝
  const { error: negErr } = await svc.from('cost_items').insert({
    budget_order_id: order.id, cost_type: 'other',
    description: '负金额测试', amount: -100, currency: 'CNY',
    exchange_rate: 1, created_by: profileId,
  })
  assert(!!negErr, `负金额被拒绝 (${negErr?.message?.slice(0, 60) ?? 'NO ERROR'})`)
}

// ═══════════════════════════════════════════════════════════
// 场景 8: Save Diagnostic 持久化
// ═══════════════════════════════════════════════════════════
async function scene8_SaveDiagnosticPersistence() {
  console.log('\n─── 场景8: Save Diagnostic 持久化 ───')

  const { data: ins, error } = await svc.from('save_diagnostic_logs').insert({
    action:      'insert',
    table_name:  'cost_items',
    record_id:   'test-record-123',
    actor_id:    'test-actor',
    source_page: '/costs',
    status:      'ok',
  }).select().single()
  assert(!error, `save_diagnostic_logs INSERT 无错误 (${error?.message ?? 'ok'})`)
  assert(!!ins?.id, '返回 ID')
  if (ins) created.push({ table: 'save_diagnostic_logs', id: ins.id })

  // 读回
  const { data: rd } = await svc.from('save_diagnostic_logs').select('*').eq('id', ins!.id).single()
  assert(rd?.action === 'insert', `action 字段正确: ${rd?.action}`)
  assert(rd?.status === 'ok', `status 字段正确: ${rd?.status}`)
}

// ═══════════════════════════════════════════════════════════
// 运行所有场景
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('财务系统端到端回归测试 (8 个场景)')
  console.log('═══════════════════════════════════════════')
  try {
    await scene1_BudgetOrderCreateAndRead()
    await scene2_BudgetOrderEditPersistence()
    await scene3_SupplierInvoiceToPaymentRequest()
    await scene4_BankReceiptToAR()
    await scene5_VoucherBalanceCheck()
    await scene6_StateMachineHardFail()
    await scene7_ARAPCrossValidation()
    await scene8_SaveDiagnosticPersistence()
  } finally {
    await cleanup()
  }

  console.log('\n═══════════════════════════════════════════')
  console.log(`结果: ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('\n失败项:')
    failures.forEach(f => console.log(`  ✗ ${f}`))
  }
  console.log('═══════════════════════════════════════════')
  process.exit(failed > 0 ? 1 : 0)
}

main()
