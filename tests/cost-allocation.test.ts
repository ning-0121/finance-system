/**
 * Issue #2: 共享原辅料分摊引擎测试
 * Run: npx tsx tests/cost-allocation.test.ts
 *
 * 验证：
 *   1. 按件数比例分摊正确
 *   2. 件数 0 时平均分摊
 *   3. 最后一笔承担舍入差额（保证合计 = 总额）
 *   4. 边界场景（单订单、空订单、零金额）
 */

import { allocateAmountByOrderQty, orderTotalQty } from '../src/lib/engines/cost-allocation'
import type { BudgetOrder, OrderItem } from '../src/lib/types'

let passed = 0
let failed = 0

function approx(a: number, b: number, tol = 0.001) {
  return Math.abs(a - b) <= tol
}

function assert(cond: boolean, label: string, detail = '') {
  if (cond) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

function section(t: string) { console.log(`\n── ${t} ──`) }

function makeOrder(id: string, qtys: number[]): BudgetOrder {
  const items: OrderItem[] = qtys.map((q, i) => ({
    product_id: `p${i}`,
    sku: `SKU${i}`,
    product_name: `Product ${i}`,
    qty: q,
    unit: 'pcs',
    unit_price: 1,
    amount: q,
  } as OrderItem))
  return {
    id,
    order_no: `O-${id}`,
    customer_id: 'c1',
    order_date: '2026-05-01',
    delivery_date: null,
    items,
    target_purchase_price: 0,
    estimated_freight: 0,
    estimated_commission: 0,
    estimated_customs_fee: 0,
    other_costs: 0,
    total_revenue: 0,
    total_cost: 0,
    estimated_profit: 0,
    estimated_margin: 0,
    currency: 'USD',
    exchange_rate: 7,
    version: 1,
    status: 'draft',
    created_by: 'u1',
    approved_by: null,
    approved_at: null,
    notes: null,
    attachments: null,
    created_at: '2026-05-01',
    updated_at: '2026-05-01',
  }
}

// ─── orderTotalQty ──────────────────────────────────────────────────────

section('orderTotalQty')
assert(orderTotalQty(makeOrder('a', [100, 200, 300])) === 600, '100+200+300 = 600')
assert(orderTotalQty(makeOrder('b', [])) === 0, '空 items → 0')
assert(orderTotalQty(makeOrder('c', [0, 0])) === 0, '全零 → 0')

// ─── allocateAmountByOrderQty ───────────────────────────────────────────

section('按件数比例分摊 — 基础场景')
{
  // 总额 ¥10,000，3 个订单（件数 100/200/700） → 1000/2000/7000
  const orders = [
    makeOrder('o1', [100]),
    makeOrder('o2', [200]),
    makeOrder('o3', [700]),
  ]
  const result = allocateAmountByOrderQty(10000, ['o1', 'o2', 'o3'], orders)
  assert(result.length === 3, '返回 3 笔')
  assert(approx(result[0].amount, 1000), `o1 = 1000 (got ${result[0].amount})`)
  assert(approx(result[1].amount, 2000), `o2 = 2000 (got ${result[1].amount})`)
  assert(approx(result[2].amount, 7000), `o3 = 7000 (got ${result[2].amount})`)
  const sum = result.reduce((s, r) => s + r.amount, 0)
  assert(approx(sum, 10000), `合计 = 10000 (got ${sum})`)
}

section('按件数比例分摊 — 含舍入差额')
{
  // 总额 ¥1,000，3 个订单（件数 1/1/1） → 333.33/333.33/333.34（最后一笔补差）
  const orders = [makeOrder('o1', [1]), makeOrder('o2', [1]), makeOrder('o3', [1])]
  const result = allocateAmountByOrderQty(1000, ['o1', 'o2', 'o3'], orders)
  const sum = result.reduce((s, r) => s + r.amount, 0)
  assert(approx(sum, 1000), `合计 = 1000 (含舍入补差，got ${sum})`)
  // 最后一笔承担差额（应该 ≥ 前面）
  assert(result[2].amount >= result[0].amount, '最后一笔承担差额')
}

section('件数全为 0 → 平均分摊')
{
  const orders = [makeOrder('o1', [0]), makeOrder('o2', [0]), makeOrder('o3', [0])]
  const result = allocateAmountByOrderQty(900, ['o1', 'o2', 'o3'], orders)
  assert(approx(result[0].amount, 300), `o1 = 300 (got ${result[0].amount})`)
  assert(approx(result[1].amount, 300), `o2 = 300 (got ${result[1].amount})`)
  assert(approx(result[2].amount, 300), `o3 = 300 (got ${result[2].amount})`)
  const sum = result.reduce((s, r) => s + r.amount, 0)
  assert(approx(sum, 900), `合计 = 900 (got ${sum})`)
}

section('边界场景')
{
  // 单订单 → 全部分摊到那个订单
  const orders = [makeOrder('o1', [100])]
  const single = allocateAmountByOrderQty(500, ['o1'], orders)
  assert(single.length === 1 && approx(single[0].amount, 500), '单订单 = 500')

  // 空 orderIds
  const empty = allocateAmountByOrderQty(500, [], [])
  assert(empty.length === 0, '空 orderIds → 空数组')

  // 零金额
  const zero = allocateAmountByOrderQty(0, ['o1'], orders)
  assert(zero.length === 0, '零金额 → 空数组')

  // 负金额（保护）
  const neg = allocateAmountByOrderQty(-100, ['o1'], orders)
  assert(neg.length === 0, '负金额 → 空数组')
}

section('权重不均 — 极端比例')
{
  // 1 + 999 件 → 1% / 99%
  const orders = [makeOrder('o1', [1]), makeOrder('o2', [999])]
  const r = allocateAmountByOrderQty(10000, ['o1', 'o2'], orders)
  assert(approx(r[0].amount, 10), `o1 = 10 (got ${r[0].amount})`)
  // 第二笔应当承担差额 = 9990
  assert(approx(r[1].amount, 9990), `o2 = 9990 (got ${r[1].amount})`)
  assert(approx(r.reduce((s, x) => s + x.amount, 0), 10000), '合计 = 10000')
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.error('\n❌ Some tests failed!')
  process.exit(1)
} else {
  console.log('\n✅ All tests passed!')
}
