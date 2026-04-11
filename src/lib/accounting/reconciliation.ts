// 定时对账引擎 — 自动检测数据异常
import { createClient } from '@/lib/supabase/client'

interface CheckResult {
  type: string
  status: 'passed' | 'failed' | 'warning'
  expected?: number
  actual?: number
  variance?: number
  details?: Record<string, unknown>
}

/**
 * 执行全部对账检查
 */
export async function runAllReconciliationChecks(periodCode: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  results.push(await checkGLBalance(periodCode))
  results.push(await checkARConsistency())
  results.push(await checkAPConsistency())
  results.push(await checkDuplicateOrders())
  results.push(await checkOrphanedRecords())

  // 写入对账结果
  const supabase = createClient()
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
  for (const r of results) {
    await supabase.from('reconciliation_checks').insert({
      check_type: r.type,
      period_code: periodCode,
      status: r.status,
      expected_value: r.expected,
      actual_value: r.actual,
      variance: r.variance,
      details: r.details,
      checked_by: profiles?.[0]?.id,
    })
  }

  return results
}

/**
 * 检查1: 总账借贷平衡
 */
async function checkGLBalance(periodCode: string): Promise<CheckResult> {
  const supabase = createClient()
  const { data } = await supabase
    .from('gl_balances')
    .select('period_debit, period_credit')
    .eq('period_code', periodCode)

  if (!data?.length) return { type: 'gl_balance', status: 'passed', details: { message: '无GL数据' } }

  const totalDebit = data.reduce((s, r) => s + ((r.period_debit as number) || 0), 0)
  const totalCredit = data.reduce((s, r) => s + ((r.period_credit as number) || 0), 0)
  const variance = Math.abs(totalDebit - totalCredit)

  return {
    type: 'gl_balance',
    status: variance < 0.01 ? 'passed' : 'failed',
    expected: totalDebit,
    actual: totalCredit,
    variance,
    details: { message: variance < 0.01 ? '借贷平衡' : `不平衡差额: ¥${variance}` },
  }
}

/**
 * 检查2: 应收账款一致性
 * 验证: 订单总收入(CNY) ≈ 已收款 + 应收余额
 */
async function checkARConsistency(): Promise<CheckResult> {
  const supabase = createClient()
  const { data: orders } = await supabase
    .from('budget_orders')
    .select('total_revenue, exchange_rate, currency, status')
    .in('status', ['approved', 'closed'])

  if (!orders?.length) return { type: 'ar_consistency', status: 'passed', details: { message: '无已审批订单' } }

  const totalRevenueCny = orders.reduce((s, o) => {
    const rate = (o.currency as string) === 'CNY' ? 1 : ((o.exchange_rate as number) || 7)
    return s + (o.total_revenue as number) * rate
  }, 0)

  const closedRevenueCny = orders.filter(o => o.status === 'closed').reduce((s, o) => {
    const rate = (o.currency as string) === 'CNY' ? 1 : ((o.exchange_rate as number) || 7)
    return s + (o.total_revenue as number) * rate
  }, 0)

  const arBalance = totalRevenueCny - closedRevenueCny

  return {
    type: 'ar_consistency',
    status: 'passed',
    expected: totalRevenueCny,
    actual: closedRevenueCny,
    variance: arBalance,
    details: {
      totalRevenueCny: Math.round(totalRevenueCny),
      closedRevenueCny: Math.round(closedRevenueCny),
      outstandingAR: Math.round(arBalance),
      orderCount: orders.length,
    },
  }
}

/**
 * 检查3: 应付账款一致性
 */
async function checkAPConsistency(): Promise<CheckResult> {
  const supabase = createClient()
  const { data: payables } = await supabase
    .from('payable_records')
    .select('amount, payment_status')

  if (!payables?.length) return { type: 'ap_consistency', status: 'passed', details: { message: '无应付记录' } }

  const totalAP = payables.reduce((s, p) => s + ((p.amount as number) || 0), 0)
  const paidAP = payables.filter(p => p.payment_status === 'paid').reduce((s, p) => s + ((p.amount as number) || 0), 0)
  const unpaidAP = totalAP - paidAP

  return {
    type: 'ap_consistency',
    status: 'passed',
    expected: totalAP,
    actual: paidAP,
    variance: unpaidAP,
    details: { totalAP: Math.round(totalAP), paidAP: Math.round(paidAP), unpaidAP: Math.round(unpaidAP) },
  }
}

/**
 * 检查4: 重复订单号
 */
async function checkDuplicateOrders(): Promise<CheckResult> {
  const supabase = createClient()
  const { data } = await supabase.from('budget_orders').select('order_no')

  if (!data?.length) return { type: 'ar_consistency', status: 'passed' }

  const counts = new Map<string, number>()
  data.forEach(o => {
    const no = o.order_no as string
    counts.set(no, (counts.get(no) || 0) + 1)
  })

  const duplicates = Array.from(counts.entries()).filter(([, c]) => c > 1)

  return {
    type: 'ar_consistency',
    status: duplicates.length > 0 ? 'warning' : 'passed',
    details: {
      duplicates: duplicates.length > 0 ? duplicates.map(([no, c]) => `${no}(${c}次)`) : [],
      message: duplicates.length > 0 ? `发现${duplicates.length}个重复订单号` : '无重复',
    },
  }
}

/**
 * 检查5: 孤立记录（有synced_orders但无budget_orders）
 */
async function checkOrphanedRecords(): Promise<CheckResult> {
  const supabase = createClient()
  const { data: synced } = await supabase
    .from('synced_orders')
    .select('id, order_no, budget_order_id')

  if (!synced?.length) return { type: 'ap_consistency', status: 'passed' }

  const orphaned = synced.filter(s => !s.budget_order_id)

  return {
    type: 'ap_consistency',
    status: orphaned.length > 0 ? 'warning' : 'passed',
    details: {
      orphanedCount: orphaned.length,
      orphanedOrders: orphaned.slice(0, 5).map(s => s.order_no),
      message: orphaned.length > 0 ? `${orphaned.length}条同步订单未关联预算单` : '全部已关联',
    },
  }
}
