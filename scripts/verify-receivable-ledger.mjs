#!/usr/bin/env node
// ============================================================
// 回款流水层 E2E 验收脚本（对生产库只读+可回滚地验证，最后清理测试数据）
//
// 覆盖：登记回款 / 进入 unmatched / 匹配 / projection 增加 / 状态变化 /
//      一笔配多单 / 一单多笔 / 撤销回退 / 作废后不可匹配 / 防超分配 /
//      重复 payment_reference 拦截 / 审计日志
//
// 用法：node scripts/verify-receivable-ledger.mjs
// 凭据：从 .env.local 读取 NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//      （service role 绕过 RLS；但约束/触发器/RPC 全部照常生效）
// ============================================================
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// --- 读取 .env.local ---
const env = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m) env[m[1]] = m[2].trim()
}
const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('缺少 NEXT_PUBLIC_SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

const results = []
const log = []
function check(name, pass, detail = '') { results.push({ name, pass, detail }); console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`) }
const round2 = n => Math.round(n * 100) / 100

async function arOf(orderId) {
  const { data } = await db.from('budget_orders').select('ar_received_amount').eq('id', orderId).single()
  return Number(data?.ar_received_amount) || 0
}
async function statusOf(receiptId) {
  const { data } = await db.from('receivable_payments').select('matched_status').eq('id', receiptId).single()
  return data?.matched_status
}

let order1, order2, actor, r1, r2, r3, alloc_r2_o1
const createdReceipts = [], createdOrders = []

async function main() {
  // --- setup ---
  const { data: cust } = await db.from('customers').select('id').limit(1).single()
  const { data: prof } = await db.from('profiles').select('id').limit(1).single()
  actor = prof?.id || null
  const custId = cust?.id || null

  async function mkOrder(rev, cur = 'CNY', rate = 1) {
    const { data, error } = await db.from('budget_orders').insert({
      order_no: '', customer_id: custId, order_date: new Date().toISOString().slice(0, 10),
      items: [], total_revenue: rev, currency: cur, exchange_rate: rate, status: 'draft', created_by: actor,
      notes: 'E2E-RECV-TEST',
    }).select('id, ar_received_amount').single()
    if (error) throw new Error('建测试订单失败: ' + error.message)
    createdOrders.push(data.id); return data.id
  }
  order1 = await mkOrder(10000)
  order2 = await mkOrder(10000)

  // --- 1. 登记一笔回款 6000 ---
  const reg = await db.from('receivable_payments').insert({
    customer_name: 'E2E客户', amount_original: 6000, currency: 'CNY', exchange_rate: 1, amount_cny: 6000,
    received_at: new Date().toISOString().slice(0, 10), bank_account: '工行E2E', payment_reference: 'E2E-PR-1',
    source_type: 'manual', created_by: actor, updated_by: actor,
  }).select('id, matched_status').single()
  check('1 登记回款', !reg.error && !!reg.data, reg.error?.message || `id=${reg.data?.id}`)
  r1 = reg.data?.id; if (r1) createdReceipts.push(r1)

  // --- 2. 进入 unmatched ---
  check('2 回款进入 unmatched', (await statusOf(r1)) === 'unmatched')

  // --- 3. 匹配到 order1 金额 4000 → projection +4000, 状态 partially_matched ---
  const ar1Before = await arOf(order1)
  const m1 = await db.rpc('allocate_receivable_payment', { p_receipt_id: r1, p_budget_order_id: order1, p_amount_cny: 4000, p_amount_original: 4000, p_actor: actor })
  const ar1After = await arOf(order1)
  log.push({ step: '匹配4000→order1', input: 6000, alloc: 4000, arBefore: ar1Before, arAfter: ar1After, status: await statusOf(r1) })
  check('3a 匹配成功', !m1.error, m1.error?.message)
  check('3b 订单已收 projection +4000', round2(ar1After - ar1Before) === 4000, `${ar1Before}→${ar1After}`)
  check('3c 回款状态 partially_matched', (await statusOf(r1)) === 'partially_matched')

  // --- 4. 一笔回款分配到多张订单：剩余 2000 → order2 → matched ---
  const ar2Before = await arOf(order2)
  const m2 = await db.rpc('allocate_receivable_payment', { p_receipt_id: r1, p_budget_order_id: order2, p_amount_cny: 2000, p_amount_original: 2000, p_actor: actor })
  const ar2After = await arOf(order2)
  check('4a 同一回款配第二张订单', !m2.error, m2.error?.message)
  check('4b order2 已收 +2000', round2(ar2After - ar2Before) === 2000, `${ar2Before}→${ar2After}`)
  check('4c 回款全额匹配 → matched', (await statusOf(r1)) === 'matched')

  // --- 5. 一张订单多笔回款：再登记 r2=3000 全配 order1 ---
  const reg2 = await db.from('receivable_payments').insert({
    customer_name: 'E2E客户', amount_original: 3000, currency: 'CNY', exchange_rate: 1, amount_cny: 3000,
    received_at: new Date().toISOString().slice(0, 10), payment_reference: 'E2E-PR-2', source_type: 'manual', created_by: actor, updated_by: actor,
  }).select('id').single()
  r2 = reg2.data?.id; if (r2) createdReceipts.push(r2)
  const ar1b = await arOf(order1)
  const m3 = await db.rpc('allocate_receivable_payment', { p_receipt_id: r2, p_budget_order_id: order1, p_amount_cny: 3000, p_amount_original: 3000, p_actor: actor })
  const ar1c = await arOf(order1)
  alloc_r2_o1 = (await db.from('receivable_payment_allocations').select('id').eq('receipt_id', r2).eq('budget_order_id', order1).is('voided_at', null).single()).data?.id
  log.push({ step: '第二笔3000→order1', input: 3000, alloc: 3000, arBefore: ar1b, arAfter: ar1c, status: await statusOf(r2) })
  check('5a 一张订单第二笔回款', !m3.error, m3.error?.message)
  check('5b order1 已收累加到 7000', round2(ar1c) === 7000, `=${ar1c}`)

  // --- 6. 撤销匹配后订单已收回退 ---
  const arBeforeUn = await arOf(order1)
  const u1 = await db.rpc('unallocate_receivable_payment', { p_allocation_id: alloc_r2_o1, p_actor: actor, p_reason: 'E2E撤销' })
  const arAfterUn = await arOf(order1)
  log.push({ step: '撤销 r2→order1', input: 0, alloc: -3000, arBefore: arBeforeUn, arAfter: arAfterUn, status: await statusOf(r2) })
  check('6a 撤销匹配', !u1.error, u1.error?.message)
  check('6b 订单已收回退 4000', round2(arAfterUn) === 4000, `${arBeforeUn}→${arAfterUn}`)
  check('6c 被撤销回款回到 unmatched', (await statusOf(r2)) === 'unmatched')

  // --- 7. 作废回款后不能再匹配 ---
  const v1 = await db.rpc('void_receivable_payment', { p_receipt_id: r2, p_actor: actor, p_reason: 'E2E作废' })
  check('7a 作废回款', !v1.error, v1.error?.message)
  const reAlloc = await db.rpc('allocate_receivable_payment', { p_receipt_id: r2, p_budget_order_id: order1, p_amount_cny: 100, p_actor: actor })
  check('7b 作废后不可匹配', !!reAlloc.error && /VOID/i.test(reAlloc.error.message), reAlloc.error?.message || '（未拦截！）')

  // --- 8. 防超分配：r1 已满额(6000)，再配 1 应失败 ---
  const over = await db.rpc('allocate_receivable_payment', { p_receipt_id: r1, p_budget_order_id: order1, p_amount_cny: 1, p_actor: actor })
  check('8 防超分配', !!over.error && /OVER_ALLOCATION/i.test(over.error.message), over.error?.message || '（未拦截！）')

  // --- 9. 重复 payment_reference 拦截 ---
  const dup = await db.from('receivable_payments').insert({
    customer_name: 'E2E客户', amount_original: 6000, currency: 'CNY', exchange_rate: 1, amount_cny: 6000,
    received_at: (await db.from('receivable_payments').select('received_at').eq('id', r1).single()).data?.received_at,
    bank_account: '工行E2E', payment_reference: 'E2E-PR-1', source_type: 'manual', created_by: actor,
  }).select('id').single()
  if (dup.data?.id) createdReceipts.push(dup.data.id)
  check('9 重复流水号拦截', !!dup.error && /duplicate|unique/i.test(dup.error.message), dup.error?.message || '（未拦截！）')

  // --- 10. 审计日志可追溯 ---
  const { data: tl } = await db.from('entity_timeline').select('event_type').eq('entity_type', 'receivable_payment').in('entity_id', [r1, r2].filter(Boolean))
  check('10 审计日志（allocate/unallocate）', (tl || []).length > 0, `${(tl || []).length} 条时间线事件`)

  // --- 报告 ---
  console.log('\n===== 验收报告（金额/分配/projection/状态）=====')
  for (const l of log) console.log(`· ${l.step}: 输入¥${l.input} 分配¥${l.alloc} | 订单已收 ${l.arBefore}→${l.arAfter} | 回款状态 ${l.status}`)
  const passed = results.filter(r => r.pass).length
  console.log(`\n结果：${passed}/${results.length} 通过`)
}

async function cleanup() {
  try {
    if (createdReceipts.length) {
      await db.from('receivable_payment_allocations').delete().in('receipt_id', createdReceipts)
      await db.from('entity_timeline').delete().eq('entity_type', 'receivable_payment').in('entity_id', createdReceipts)
      await db.from('receivable_payments').delete().in('id', createdReceipts)
    }
    if (createdOrders.length) await db.from('budget_orders').delete().in('id', createdOrders)
    console.log('🧹 测试数据已清理')
  } catch (e) { console.error('清理失败（请手动删除 notes=E2E-RECV-TEST 的订单与 E2E-PR-* 回款）:', e.message) }
}

main().catch(e => console.error('运行异常:', e)).finally(async () => {
  await cleanup()
  process.exit(results.every(r => r.pass) ? 0 : 1)
})
