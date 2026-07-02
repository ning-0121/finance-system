// 定时对账引擎 — 自动检测数据异常
import { createClient } from '@/lib/supabase/server'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { safeRate, sumAmounts, mulAmount } from './utils'

export interface CheckResult {
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

  // 写入对账结果 — checked_by 取真实登录人；系统自动巡检（无会话）记 null，
  // 不冒用"第一个 profile"（防审计归属伪造）
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()
  for (const r of results) {
    await supabase.from('reconciliation_checks').insert({
      check_type: r.type,
      period_code: periodCode,
      status: r.status,
      expected_value: r.expected,
      actual_value: r.actual,
      variance: r.variance,
      details: r.details,
      checked_by: userData?.user?.id ?? null,
    })
  }

  return results
}

/**
 * 检查1: 总账借贷平衡
 */
export async function checkGLBalance(periodCode: string): Promise<CheckResult> {
  const supabase = await createClient()
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
 * 验证: 合同应收(CNY) = 权威已收(回款分配合计) + 应收余额；且不应出现系统性「多收」。
 * 权威已收口径与应收账款页/毛利表一致(receivable_payment_allocations.amount_cny)，
 * 不再用「已closed=已全收」的伪口径(那样恒 passed、形同虚设)。
 */
export async function checkARConsistency(): Promise<CheckResult> {
  const supabase = await createClient()
  const { data: orders } = await fetchAll<Record<string, unknown>>((f, t) => supabase
    .from('budget_orders')
    .select('total_revenue, exchange_rate, currency, status')
    .in('status', ['approved', 'closed']).order('id', { ascending: true }).range(f, t))

  if (!orders?.length) return { type: 'ar_consistency', status: 'passed', details: { message: '无已审批订单' } }

  const contractCny = sumAmounts(orders.map(o => {
    const rate = safeRate(o.exchange_rate as number, o.currency as string, `reconciliation order ${(o as Record<string, unknown>).id ?? ''}`)
    return mulAmount(o.total_revenue as number, rate)
  }))

  // 权威已收：回款分配合计(未作废)
  const { data: allocs } = await fetchAll<Record<string, unknown>>((f, t) => supabase
    .from('receivable_payment_allocations')
    .select('amount_cny').is('voided_at', null).order('id', { ascending: true }).range(f, t))
  const receivedCny = sumAmounts((allocs || []).map(a => Number(a.amount_cny) || 0))

  const outstandingAR = Math.round((contractCny - receivedCny) * 100) / 100
  // 系统性多收(已收 > 合同应收，超容差)判为异常，需人工核查后才可锁账
  const overCollected = receivedCny - contractCny > 1
  return {
    type: 'ar_consistency',
    status: overCollected ? 'failed' : 'passed',
    expected: Math.round(contractCny),
    actual: Math.round(receivedCny),
    variance: outstandingAR,
    details: {
      contractCny: Math.round(contractCny),
      receivedCny: Math.round(receivedCny),
      outstandingAR: Math.round(outstandingAR),
      orderCount: orders.length,
      note: overCollected ? '已收合计超过合同应收，请核查是否有错配/重复回款' : '合同应收 = 已收 + 应收余额',
    },
  }
}

/**
 * 检查3: 应付账款一致性
 */
export async function checkAPConsistency(): Promise<CheckResult> {
  const supabase = await createClient()
  // 与应付工作台/经营面板同口径：应付 = cost_items(按币种折 CNY) 合计；已付 = supplier_payments 合计。
  // 不再用 payable_records(与业务页口径不一致、且恒 passed)。
  const [{ data: costs }, { data: pays }] = await Promise.all([
    fetchAll<Record<string, unknown>>((f, t) => supabase
      .from('cost_items').select('amount, currency, exchange_rate')
      .is('deleted_at', null).order('id', { ascending: true }).range(f, t)),
    fetchAll<Record<string, unknown>>((f, t) => supabase
      .from('supplier_payments').select('amount').is('deleted_at', null).order('id', { ascending: true }).range(f, t)),
  ])

  if (!costs?.length && !pays?.length) return { type: 'ap_consistency', status: 'passed', details: { message: '无应付/付款记录' } }

  const totalAP = sumAmounts((costs || []).map(c => {
    const rate = ((c.currency as string) || 'CNY') === 'CNY' ? 1 : (Number(c.exchange_rate) || 1)
    return mulAmount(c.amount as number, rate)
  }))
  const paidAP = sumAmounts((pays || []).map(p => Number(p.amount) || 0))
  const unpaidAP = Math.round((totalAP - paidAP) * 100) / 100
  // 已付超过应付(超容差)判异常
  const overPaid = paidAP - totalAP > 1

  return {
    type: 'ap_consistency',
    status: overPaid ? 'failed' : 'passed',
    expected: Math.round(totalAP),
    actual: Math.round(paidAP),
    variance: unpaidAP,
    details: {
      totalAP: Math.round(totalAP), paidAP: Math.round(paidAP), unpaidAP: Math.round(unpaidAP),
      note: overPaid ? '已付合计超过应付(费用归集)，请核查重复付款/错配' : '应付 = cost_items 合计；已付 = supplier_payments 合计',
    },
  }
}

/**
 * 检查4: 重复订单号
 */
export async function checkDuplicateOrders(): Promise<CheckResult> {
  const supabase = await createClient()
  const { data } = await fetchAll<Record<string, unknown>>((f, t) => supabase.from('budget_orders')
    .select('order_no').order('id', { ascending: true }).range(f, t))

  if (!data?.length) return { type: 'duplicate_orders', status: 'passed' }

  const counts = new Map<string, number>()
  data.forEach(o => {
    const no = o.order_no as string
    counts.set(no, (counts.get(no) || 0) + 1)
  })

  const duplicates = Array.from(counts.entries()).filter(([, c]) => c > 1)

  return {
    type: 'duplicate_orders',
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
export async function checkOrphanedRecords(): Promise<CheckResult> {
  const supabase = await createClient()
  const { data: synced } = await fetchAll<Record<string, unknown>>((f, t) => supabase
    .from('synced_orders')
    .select('id, order_no, budget_order_id').order('id', { ascending: true }).range(f, t))

  if (!synced?.length) return { type: 'orphaned_records', status: 'passed' }

  const orphaned = synced.filter(s => !s.budget_order_id)

  return {
    type: 'orphaned_records',
    status: orphaned.length > 0 ? 'warning' : 'passed',
    details: {
      orphanedCount: orphaned.length,
      orphanedOrders: orphaned.slice(0, 5).map(s => s.order_no),
      message: orphaned.length > 0 ? `${orphaned.length}条同步订单未关联预算单` : '全部已关联',
    },
  }
}
