// ============================================================
// Financial Integrity Engine — 财务可信度巡检（Phase 2 #3）
//
// 8 组检查：总量盘点 + 7 条勾稽链路 + 唯一性。
// 评分：100 − 加权扣分（严重 -1.5/条，警告 -0.4/条，提示 -0.05/条，各档封顶）。
// GL 勾稽（应收/应付/利润 vs GL）在灰度期记 info 不重扣——GL 尚未全量过账，
// 偏差是预期内的"灰度距离"，仅展示供财务观察收敛趋势。
//
// 引擎接受 SupabaseClient 注入：cron 用 service-role，手动触发用用户会话。
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

type Severity = 'critical' | 'warning' | 'info'

export interface IntegrityCheck {
  key: string
  label: string
  status: 'passed' | 'failed'
  severity: Severity        // failed 时的级别
  count: number             // 异常条数
  varianceCny?: number      // 金额差异（如适用）
  detail: string
  items?: { id: string; label: string }[]  // 异常样例（最多 10 条，供页面钻取）
}

export interface IntegrityRunResult {
  score: number
  dimensionScores: { completeness: number; consistency: number; uniqueness: number; timeliness: number }
  counts: Record<string, number>
  checks: IntegrityCheck[]
  criticalCount: number
  warningCount: number
  infoCount: number
  summaryText: string
}

const r2 = (n: number) => Math.round(n * 100) / 100
const cnyRate = (currency: string | null, rate: number | null) =>
  (currency || 'CNY') === 'CNY' ? 1 : (Number(rate) || 1)

async function fetchAllRows<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999)
    if (error || !data || data.length === 0) break
    all.push(...data)
    if (data.length < 1000) break
  }
  return all
}

export async function runIntegrityCheck(supabase: SupabaseClient, trigger: 'cron' | 'manual' | 'closing' = 'manual'): Promise<IntegrityRunResult> {
  const checks: IntegrityCheck[] = []

  // ── 数据拉取（分页全量）──────────────────────────────
  const [orders, settlements, journals, receipts, allocations, payments, costItems, payables, glBalances] = await Promise.all([
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('budget_orders')
      .select('id, order_no, status, total_revenue, currency, exchange_rate, ar_received_amount, delivery_date, order_date')
      .is('deleted_at', null).order('id').range(f, t)),
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('order_settlements')
      .select('id, budget_order_id, status, final_profit').order('id').range(f, t)),
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('journal_entries')
      .select('id, source_type, source_id, status, total_debit').neq('status', 'voided').order('id').range(f, t)),
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('receivable_payments')
      .select('id, customer_name, amount_cny, payment_reference, received_at, created_at').is('voided_at', null).order('id').range(f, t)),
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('receivable_payment_allocations')
      .select('id, payment_id, budget_order_id, amount_cny').is('voided_at', null).order('id').range(f, t)),
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('supplier_payments')
      .select('id, supplier_name, amount, paid_at, note').is('deleted_at', null).order('id').range(f, t)),
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('cost_items')
      .select('id, supplier, amount, currency, exchange_rate, budget_order_id').is('deleted_at', null).order('id').range(f, t)),
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('payable_records')
      .select('id, supplier_name, amount, payment_status, paid_at').neq('payment_status', 'cancelled').order('id').range(f, t)),
    fetchAllRows<Record<string, unknown>>((f, t) => supabase.from('gl_balances')
      .select('account_code, period_debit, period_credit').order('account_code').range(f, t)),
  ])

  // ── 总量卡 ─────────────────────────────────────────
  const counts = {
    budget_orders: orders.length,
    settlements: settlements.length,
    journal_entries: journals.length,
    receipts: receipts.length,
    supplier_payments: payments.length,
    cost_items: costItems.length,
  }

  // ── ① 预算 → 决算（完整性）────────────────────────
  const settledOrderIds = new Set(settlements.map(s => s.budget_order_id as string))
  const needSettle = orders.filter(o => (o.status === 'approved' || o.status === 'closed'))
  const unsettled = needSettle.filter(o => !settledOrderIds.has(o.id as string))
  checks.push({
    key: 'budget_to_settlement', label: '预算 → 决算',
    status: unsettled.length === 0 ? 'passed' : 'failed', severity: 'warning',
    count: unsettled.length,
    detail: unsettled.length === 0 ? `${needSettle.length} 张已批准订单全部有决算` : `${unsettled.length} 张已批准订单未生成决算`,
    items: unsettled.slice(0, 10).map(o => ({ id: o.id as string, label: (o.order_no as string) || (o.id as string) })),
  })

  // ── ② 决算 → 凭证（完整性，GL 灰度期记 info）──────
  const voucherSourceIds = new Set(journals.map(j => `${j.source_type}|${j.source_id}`))
  const confirmedSettlements = settlements.filter(s => s.status === 'confirmed')
  const noVoucher = confirmedSettlements.filter(s => !voucherSourceIds.has(`settlement|${s.budget_order_id}`))
  checks.push({
    key: 'settlement_to_voucher', label: '决算 → 凭证',
    status: noVoucher.length === 0 ? 'passed' : 'failed', severity: 'info',
    count: noVoucher.length,
    detail: noVoucher.length === 0 ? '已确认决算均有凭证' : `${noVoucher.length} 张已确认决算无对应凭证（GL 灰度期参考）`,
  })

  // ── ③ 回款 → 应收（一致性 + 及时性）────────────────
  // 3a. projection 漂移：有流水的订单，分配合计 vs ar_received_amount 折CNY
  const allocByOrder = new Map<string, number>()
  allocations.forEach(a => {
    const k = a.budget_order_id as string
    allocByOrder.set(k, (allocByOrder.get(k) || 0) + (Number(a.amount_cny) || 0))
  })
  const drifted: { id: string; label: string }[] = []
  let driftCny = 0
  for (const o of orders) {
    const alloc = allocByOrder.get(o.id as string)
    if (alloc == null) continue
    const projCny = r2((Number(o.ar_received_amount) || 0) * cnyRate(o.currency as string, o.exchange_rate as number))
    const diff = Math.abs(r2(alloc) - projCny)
    if (diff > 0.05) { drifted.push({ id: o.id as string, label: `${o.order_no} 差¥${r2(diff)}` }); driftCny += diff }
  }
  checks.push({
    key: 'ar_projection_drift', label: '回款 → 应收（projection 一致性）',
    status: drifted.length === 0 ? 'passed' : 'failed', severity: 'critical',
    count: drifted.length, varianceCny: r2(driftCny),
    detail: drifted.length === 0 ? '回款分配与应收缓存完全一致' : `${drifted.length} 张订单已收缓存与流水分配不一致（合计差¥${r2(driftCny)}）`,
    items: drifted.slice(0, 10),
  })
  // 3b. 未匹配回款（>7 天）
  const allocByPayment = new Map<string, number>()
  allocations.forEach(a => {
    const k = a.payment_id as string
    allocByPayment.set(k, (allocByPayment.get(k) || 0) + (Number(a.amount_cny) || 0))
  })
  const now = Date.now()
  const unmatched = receipts.filter(p => {
    const remaining = (Number(p.amount_cny) || 0) - (allocByPayment.get(p.id as string) || 0)
    const ageDays = (now - new Date((p.received_at || p.created_at) as string).getTime()) / 86400000
    return remaining > 0.005 && ageDays > 7
  })
  checks.push({
    key: 'unmatched_receipts', label: '回款匹配及时性',
    status: unmatched.length === 0 ? 'passed' : 'failed', severity: 'warning',
    count: unmatched.length,
    detail: unmatched.length === 0 ? '无超 7 天未匹配回款' : `${unmatched.length} 笔回款超 7 天未匹配完`,
    items: unmatched.slice(0, 10).map(p => ({ id: p.id as string, label: `${p.customer_name || '?'} ¥${p.amount_cny}` })),
  })

  // ── ④ 付款 → 应付（一致性）────────────────────────
  // 4a. 供应商多付：已付 > 费用总额
  const costBySupplier = new Map<string, number>()
  costItems.forEach(c => {
    const k = ((c.supplier as string) || '').trim()
    if (!k) return
    costBySupplier.set(k, (costBySupplier.get(k) || 0) + (Number(c.amount) || 0) * cnyRate(c.currency as string, c.exchange_rate as number))
  })
  const paidBySupplier = new Map<string, number>()
  payments.forEach(p => {
    const k = ((p.supplier_name as string) || '').trim()
    paidBySupplier.set(k, (paidBySupplier.get(k) || 0) + (Number(p.amount) || 0))
  })
  const overpaid: { id: string; label: string }[] = []
  for (const [sup, paid] of paidBySupplier) {
    const total = costBySupplier.get(sup) || 0
    if (paid - total > 0.05) overpaid.push({ id: sup, label: `${sup} 多付¥${r2(paid - total)}` })
  }
  checks.push({
    key: 'ap_overpaid', label: '付款 → 应付（多付检测）',
    status: overpaid.length === 0 ? 'passed' : 'failed', severity: 'warning',
    count: overpaid.length,
    detail: overpaid.length === 0 ? '无供应商已付超过应付' : `${overpaid.length} 个供应商已付金额超过费用总额`,
    items: overpaid.slice(0, 10),
  })
  // 4b. 出纳已付但未同步供应商流水（两套账断点）
  const syncedPayableIds = new Set(
    payments.map(p => { const m = /payable:([0-9a-f-]+)/.exec((p.note as string) || ''); return m?.[1] }).filter(Boolean) as string[]
  )
  const paidNoSync = payables.filter(r => r.payment_status === 'paid' && r.paid_at
    && new Date(r.paid_at as string).getTime() > new Date('2026-06-11').getTime() // 打通机制上线后的才算异常
    && !syncedPayableIds.has(r.id as string))
  checks.push({
    key: 'pay_two_ledger_sync', label: '出纳付款 → 应付工作台同步',
    status: paidNoSync.length === 0 ? 'passed' : 'failed', severity: 'warning',
    count: paidNoSync.length,
    detail: paidNoSync.length === 0 ? '出纳付款均已同步供应商流水' : `${paidNoSync.length} 笔出纳付款未同步到供应商付款流水`,
    items: paidNoSync.slice(0, 10).map(r => ({ id: r.id as string, label: `${r.supplier_name} ¥${r.amount}` })),
  })

  // ── ⑤ 应收/应付/利润 vs GL（灰度期 info 参考）───────
  const glBal = (prefix: string) => r2(glBalances
    .filter(b => String(b.account_code || '').startsWith(prefix))
    .reduce((s, b) => s + (Number(b.period_debit) || 0) - (Number(b.period_credit) || 0), 0))
  const glHasData = glBalances.length > 0
  const bizArCny = r2(orders.reduce((s, o) => {
    const rate = cnyRate(o.currency as string, o.exchange_rate as number)
    const contract = (Number(o.total_revenue) || 0) * rate
    const received = allocByOrder.get(o.id as string) ?? (Number(o.ar_received_amount) || 0) * rate
    return s + Math.max(0, contract - received)
  }, 0))
  const glArCny = glBal('1122')
  checks.push({
    key: 'ar_vs_gl', label: '应收 → GL（1122）',
    status: !glHasData || Math.abs(bizArCny - glArCny) < 1 ? 'passed' : 'failed', severity: 'info',
    count: glHasData && Math.abs(bizArCny - glArCny) >= 1 ? 1 : 0,
    varianceCny: glHasData ? r2(bizArCny - glArCny) : 0,
    detail: !glHasData ? 'GL 无余额数据（灰度未过账），暂不比对'
      : `业务应收 ¥${bizArCny.toLocaleString()} vs GL ¥${glArCny.toLocaleString()}，差 ¥${r2(bizArCny - glArCny).toLocaleString()}（灰度期参考）`,
  })

  // ── ⑥ 唯一性：重复付款 / 重复回款 ──────────────────
  const dupPay: { id: string; label: string }[] = []
  const payKeyMap = new Map<string, Record<string, unknown>>()
  for (const p of payments) {
    const day = String(p.paid_at || '').slice(0, 10)
    const key = `${(p.supplier_name as string || '').trim()}|${p.amount}|${day}`
    if (payKeyMap.has(key)) dupPay.push({ id: p.id as string, label: `${p.supplier_name} ¥${p.amount} @${day}` })
    else payKeyMap.set(key, p)
  }
  const dupRec: { id: string; label: string }[] = []
  const recKeyMap = new Map<string, Record<string, unknown>>()
  for (const p of receipts) {
    const ref = (p.payment_reference as string || '').trim()
    const day = String(p.received_at || '').slice(0, 10)
    const key = `${(p.customer_name as string || '').trim()}|${p.amount_cny}|${ref || day}`
    if (recKeyMap.has(key)) dupRec.push({ id: p.id as string, label: `${p.customer_name} ¥${p.amount_cny}` })
    else recKeyMap.set(key, p)
  }
  checks.push({
    key: 'dup_payments', label: '唯一性：重复付款',
    status: dupPay.length === 0 ? 'passed' : 'failed', severity: 'critical',
    count: dupPay.length,
    detail: dupPay.length === 0 ? '无同供应商同金额同日重复付款' : `${dupPay.length} 笔疑似重复付款`,
    items: dupPay.slice(0, 10),
  })
  checks.push({
    key: 'dup_receipts', label: '唯一性：重复回款',
    status: dupRec.length === 0 ? 'passed' : 'failed', severity: 'critical',
    count: dupRec.length,
    detail: dupRec.length === 0 ? '无疑似重复回款' : `${dupRec.length} 笔疑似重复回款`,
    items: dupRec.slice(0, 10),
  })

  // ── 评分 ───────────────────────────────────────────
  const failed = checks.filter(c => c.status === 'failed')
  const criticalCount = failed.filter(c => c.severity === 'critical').reduce((s, c) => s + c.count, 0)
  const warningCount = failed.filter(c => c.severity === 'warning').reduce((s, c) => s + c.count, 0)
  const infoCount = failed.filter(c => c.severity === 'info').reduce((s, c) => s + c.count, 0)
  const deduction = Math.min(30, criticalCount * 1.5) + Math.min(20, warningCount * 0.4) + Math.min(5, infoCount * 0.05)
  const score = Math.max(0, r2(100 - deduction))

  const dim = (keys: string[]) => {
    const rel = failed.filter(c => keys.includes(c.key))
    const d = rel.reduce((s, c) => s + (c.severity === 'critical' ? c.count * 1.5 : c.severity === 'warning' ? c.count * 0.4 : c.count * 0.05), 0)
    return Math.max(0, r2(100 - Math.min(40, d)))
  }
  const dimensionScores = {
    completeness: dim(['budget_to_settlement', 'settlement_to_voucher']),
    consistency: dim(['ar_projection_drift', 'ap_overpaid', 'pay_two_ledger_sync', 'ar_vs_gl']),
    uniqueness: dim(['dup_payments', 'dup_receipts']),
    timeliness: dim(['unmatched_receipts']),
  }

  const failedSummary = failed.filter(c => c.count > 0).map(c => `${c.label}: ${c.count}`).join('；') || '全部通过'
  const summaryText = `可信度 ${score}%（严重 ${criticalCount} / 警告 ${warningCount} / 提示 ${infoCount}）— ${failedSummary}`

  // ── 落库 ───────────────────────────────────────────
  const { data: userData } = await supabase.auth.getUser()
  const { error: insErr } = await supabase.from('integrity_runs').insert({
    trigger,
    score,
    dimension_scores: dimensionScores,
    counts,
    checks: checks as unknown as Record<string, unknown>[],
    critical_count: criticalCount,
    warning_count: warningCount,
    info_count: infoCount,
    summary_text: summaryText,
    created_by: userData?.user?.id ?? null,
  })
  if (insErr) console.error('[integrity] 巡检结果落库失败:', insErr.message)

  return { score, dimensionScores, counts, checks, criticalCount, warningCount, infoCount, summaryText }
}
