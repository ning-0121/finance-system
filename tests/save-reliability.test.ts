/**
 * 保存可靠性回归测试
 * 专门验证"保存后数据消失"问题不再复现
 *
 * 运行方式: npx tsx tests/save-reliability.test.ts
 *
 * 需要环境变量:
 * NEXT_PUBLIC_SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY (用service_role绕过RLS测试)
 * NEXT_PUBLIC_SUPABASE_ANON_KEY (模拟前端环境)
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('缺少环境变量，请设置 NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY)
const anonClient = createClient(SUPABASE_URL, ANON_KEY)

let passed = 0
let failed = 0
const failures: string[] = []

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    failures.push(msg)
    console.log(`  ✗ FAIL: ${msg}`)
  }
}

// ========== TEST 1: cost_items 写入→回读 ==========
async function testCostItemPersistence() {
  console.log('\n=== TEST 1: 费用录入持久化 ===')

  // 获取profile
  const { data: profiles } = await serviceClient.from('profiles').select('id').limit(1)
  const profileId = profiles?.[0]?.id
  assert(!!profileId, '存在至少一个profile')
  if (!profileId) return

  // 用service key写入
  const testDesc = `test-save-${Date.now()}`
  const { data: inserted, error: insertErr } = await serviceClient
    .from('cost_items')
    .insert({ cost_type: 'other', description: testDesc, amount: 100, currency: 'CNY', exchange_rate: 1, created_by: profileId })
    .select()
    .single()

  assert(!insertErr, `INSERT成功 (error: ${insertErr?.message || 'none'})`)
  assert(!!inserted?.id, `返回ID: ${inserted?.id}`)

  if (!inserted) return

  // 用anon key回读（模拟前端）
  const { data: readBack, error: readErr } = await anonClient
    .from('cost_items')
    .select('*')
    .eq('id', inserted.id)
    .single()

  assert(!readErr, `ANON SELECT成功 (error: ${readErr?.message || 'none'})`)
  assert(!!readBack, '回读数据不为空')
  assert(readBack?.description === testDesc, `描述一致: ${readBack?.description}`)
  assert(readBack?.amount === 100, `金额一致: ${readBack?.amount}`)

  // 清理
  await serviceClient.from('cost_items').delete().eq('id', inserted.id)
}

// ========== TEST 2: budget_orders 写入→回读 ==========
async function testBudgetOrderPersistence() {
  console.log('\n=== TEST 2: 预算单持久化 ===')

  const { data: profiles } = await serviceClient.from('profiles').select('id').limit(1)
  const { data: customers } = await serviceClient.from('customers').select('id').limit(1)
  if (!profiles?.[0]?.id || !customers?.[0]?.id) { console.log('  跳过: 无profile或customer'); return }

  const { data: inserted, error: insertErr } = await serviceClient
    .from('budget_orders')
    .insert({
      order_no: `TEST-${Date.now()}`,
      customer_id: customers[0].id,
      total_revenue: 10000,
      total_cost: 8000,
      estimated_profit: 2000,
      estimated_margin: 20,
      currency: 'USD',
      exchange_rate: 7,
      status: 'draft',
      created_by: profiles[0].id,
      order_date: '2026-04-11',
    })
    .select()
    .single()

  assert(!insertErr, `INSERT成功 (error: ${insertErr?.message || 'none'})`)

  if (!inserted) return

  // anon key回读
  const { data: readBack } = await anonClient.from('budget_orders').select('*').eq('id', inserted.id).single()
  assert(!!readBack, 'ANON回读不为空')
  assert(readBack?.total_revenue === 10000, `收入一致: ${readBack?.total_revenue}`)
  assert(readBack?.total_cost === 8000, `成本一致: ${readBack?.total_cost}`)

  // 清理
  await serviceClient.from('budget_orders').delete().eq('id', inserted.id)
}

// ========== TEST 3: 负金额校验 ==========
async function testNegativeAmountRejection() {
  console.log('\n=== TEST 3: 负金额拒绝 ===')

  const { data: profiles } = await serviceClient.from('profiles').select('id').limit(1)
  if (!profiles?.[0]?.id) return

  const { error } = await serviceClient
    .from('cost_items')
    .insert({ cost_type: 'other', description: 'negative-test', amount: -100, currency: 'CNY', exchange_rate: 1, created_by: profiles[0].id })

  assert(!!error, '负金额被拒绝: ' + (error?.message || 'NO ERROR'))
}

// ========== TEST 4: 零汇率校验 ==========
async function testZeroExchangeRate() {
  console.log('\n=== TEST 4: 零汇率拒绝 ===')

  const { data: profiles } = await serviceClient.from('profiles').select('id').limit(1)
  const { data: customers } = await serviceClient.from('customers').select('id').limit(1)
  if (!profiles?.[0]?.id || !customers?.[0]?.id) return

  const { error } = await serviceClient
    .from('budget_orders')
    .insert({
      order_no: `ZERO-RATE-${Date.now()}`,
      customer_id: customers[0].id,
      total_revenue: 1000, exchange_rate: 0,
      currency: 'USD', status: 'draft', created_by: profiles[0].id, order_date: '2026-04-11',
    })

  assert(!!error, '零汇率被拒绝: ' + (error?.message || 'NO ERROR'))
}

// ========== TEST 5: 状态机非法转换 ==========
async function testIllegalStateTransition() {
  console.log('\n=== TEST 5: 非法状态转换拒绝 ===')

  // 找一个closed的订单
  const { data: closedOrders } = await serviceClient
    .from('budget_orders')
    .select('id, status')
    .eq('status', 'closed')
    .limit(1)

  if (!closedOrders?.length) {
    console.log('  跳过: 无closed状态订单')
    return
  }

  const { error } = await serviceClient
    .from('budget_orders')
    .update({ status: 'draft' })
    .eq('id', closedOrders[0].id)

  assert(!!error, 'closed→draft被拒绝: ' + (error?.message || 'NO ERROR'))
}

// ========== TEST 6: 乐观锁并发保护 ==========
async function testOptimisticLocking() {
  console.log('\n=== TEST 6: 乐观锁保护 ===')

  const { data: orders } = await serviceClient
    .from('budget_orders')
    .select('id, version, status')
    .eq('status', 'draft')
    .limit(1)

  if (!orders?.length) {
    console.log('  跳过: 无draft订单')
    return
  }

  const order = orders[0]
  const wrongVersion = (order.version || 1) + 999

  // 用错误version更新应该返回空
  const { data, error } = await serviceClient
    .from('budget_orders')
    .update({ notes: 'lock-test' })
    .eq('id', order.id)
    .eq('version', wrongVersion)
    .select()

  assert(!error, '查询本身不报错')
  assert(!data?.length || data.length === 0, `错误version更新不影响数据: ${data?.length || 0} rows`)
}

// ========== TEST 7: 借贷平衡 ==========
async function testDebitCreditBalance() {
  console.log('\n=== TEST 7: 借贷平衡校验 ===')

  const { data: profiles } = await serviceClient.from('profiles').select('id').limit(1)
  if (!profiles?.[0]?.id) return

  // 尝试插入不平衡凭证
  const { error } = await serviceClient
    .from('journal_entries')
    .insert({
      voucher_no: `BAD-${Date.now()}`,
      period_code: '2026-04',
      voucher_date: '2026-04-11',
      description: '不平衡测试',
      total_debit: 1000,
      total_credit: 999, // 不等于debit
      status: 'draft',
      created_by: profiles[0].id,
    })

  assert(!!error, '不平衡凭证被拒绝: ' + (error?.message || 'NO ERROR'))
}

// ========== 运行所有测试 ==========
async function runAll() {
  console.log('====================================')
  console.log('财务系统保存可靠性回归测试')
  console.log('====================================')

  await testCostItemPersistence()
  await testBudgetOrderPersistence()
  await testNegativeAmountRejection()
  await testZeroExchangeRate()
  await testIllegalStateTransition()
  await testOptimisticLocking()
  await testDebitCreditBalance()

  console.log('\n====================================')
  console.log(`结果: ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('失败项:')
    failures.forEach(f => console.log(`  - ${f}`))
  }
  console.log('====================================')

  process.exit(failed > 0 ? 1 : 0)
}

runAll()
