// ============================================================
// Closing Engine — Month-end / Year-end Period Close
// ============================================================
// Orchestrates a 12-check month-end checklist, reusing existing
// reconciliation, GL, and FX modules. Supports overrides, timeline
// auditing, and year-end carry-forward journal entries.

import { createClient } from '@/lib/supabase/server'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { normalizeSupplierName } from '@/lib/utils'
import { recordTimelineEvent } from './timeline-engine'
import {
  checkGLBalance,
  checkARConsistency,
  checkAPConsistency,
  checkDuplicateOrders,
  checkOrphanedRecords,
  type CheckResult,
} from '@/lib/accounting/reconciliation'
import { getTrialBalance, getProfitAndLoss } from '@/lib/accounting/gl-posting'
import { calculateAllFxGains, createFxRevaluationDraft } from '@/lib/accounting/fx-gains'

// --------------- Types ---------------

export interface ClosingCheckItem {
  id: string
  periodCode: string
  checkKey: string
  checkLabel: string
  checkOrder: number
  status: 'pending' | 'passed' | 'failed' | 'skipped' | 'overridden'
  result: Record<string, unknown> | null
  executedAt: string | null
  executedBy: string | null
  overrideReason: string | null
  approvedBy: string | null
  approvedAt: string | null
}

export interface ClosingResult {
  periodCode: string
  totalChecks: number
  passed: number
  failed: number
  skipped: number
  overridden: number
  pending: number
  allClear: boolean
  items: ClosingCheckItem[]
}

// --------------- Constants ---------------

const MONTH_CHECKS = [
  { key: 'pending_budgets', label: '未审批预算单', order: 1 },
  { key: 'pending_payments', label: '未审批付款', order: 2 },
  { key: 'pending_vouchers', label: '未过账凭证', order: 3 },
  { key: 'gl_balance', label: '总账借贷平衡', order: 4 },
  { key: 'ar_consistency', label: '应收一致性', order: 5 },
  { key: 'ap_consistency', label: '应付一致性', order: 6 },
  { key: 'duplicate_check', label: '重复订单检查', order: 7 },
  { key: 'orphaned_check', label: '孤立记录检查', order: 8 },
  { key: 'unconfirmed_settlements', label: '未确认决算', order: 9 },
  { key: 'open_risk_events', label: '未处理风险', order: 10 },
  { key: 'trial_balance', label: '试算平衡验证', order: 11 },
  { key: 'fx_revaluation', label: '外汇重估', order: 12 },
] as const

// --------------- Helpers ---------------

function mapRow(row: Record<string, unknown>): ClosingCheckItem {
  return {
    id: row.id as string,
    periodCode: row.period_code as string,
    checkKey: row.check_key as string,
    checkLabel: row.check_label as string,
    checkOrder: row.check_order as number,
    status: row.status as ClosingCheckItem['status'],
    result: (row.result as Record<string, unknown>) ?? null,
    executedAt: (row.executed_at as string) ?? null,
    executedBy: (row.executed_by as string) ?? null,
    overrideReason: (row.override_reason as string) ?? null,
    approvedBy: (row.approved_by as string) ?? null,
    approvedAt: (row.approved_at as string) ?? null,
  }
}

// --------------- Public API ---------------

/**
 * Initialize checklist rows for a given period. Idempotent — skips if rows exist.
 */
export async function initClosingChecklist(
  periodCode: string,
  closeType: 'month' | 'year'
): Promise<void> {
  const supabase = await createClient()

  // Check if already initialized
  const { data: existing } = await supabase
    .from('period_close_checklists')
    .select('id')
    .eq('period_code', periodCode)
    .limit(1)

  if (existing && existing.length > 0) return

  // Set period status to 'closing'
  await supabase
    .from('accounting_periods')
    .update({ status: 'closing' })
    .eq('period_code', periodCode)

  // Insert all check items
  const rows = MONTH_CHECKS.map((c) => ({
    period_code: periodCode,
    close_type: closeType,
    check_key: c.key,
    check_label: c.label,
    check_order: c.order,
    status: 'pending',
  }))

  const { error } = await supabase.from('period_close_checklists').insert(rows)
  if (error) throw new Error(`初始化结账清单失败: ${error.message}`)

  await recordTimelineEvent({
    entityType: 'period_close',
    entityId: periodCode,
    eventType: 'closing_initiated',
    eventTitle: `${closeType === 'year' ? '年结' : '月结'}流程启动 ${periodCode}`,
    sourceType: 'system',
  })
}

/**
 * Execute a single closing check by key. Returns the check result and updates the DB row.
 */
export async function executeClosingCheck(
  periodCode: string,
  checkKey: string
): Promise<CheckResult> {
  const supabase = await createClient()
  let result: CheckResult

  switch (checkKey) {
    // --- Reuse reconciliation.ts ---
    case 'gl_balance':
      result = await checkGLBalance(periodCode)
      break
    case 'ar_consistency':
      result = await checkARConsistency()
      break
    case 'ap_consistency':
      result = await checkAPConsistency()
      break
    case 'duplicate_check':
      result = await checkDuplicateOrders()
      break
    case 'orphaned_check':
      result = await checkOrphanedRecords()
      break

    // --- Pending items checks ---
    case 'pending_budgets': {
      const { count } = await supabase
        .from('budget_orders')
        .select('id', { count: 'exact', head: true })
        .in('status', ['draft', 'pending_review'])
      const pending = count ?? 0
      result = {
        type: 'pending_budgets',
        status: pending === 0 ? 'passed' : 'failed',
        actual: pending,
        details: { message: pending === 0 ? '无未审批预算单' : `${pending}张预算单待审批` },
      }
      break
    }
    case 'pending_payments': {
      const { count } = await supabase
        .from('payable_records')
        .select('id', { count: 'exact', head: true })
        .eq('payment_status', 'pending_approval')
      const pending = count ?? 0
      result = {
        type: 'pending_payments',
        status: pending === 0 ? 'passed' : 'failed',
        actual: pending,
        details: { message: pending === 0 ? '无未审批付款' : `${pending}笔付款待审批` },
      }
      break
    }
    case 'pending_vouchers': {
      const { count } = await supabase
        .from('journal_entries')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'draft')
        .eq('period_code', periodCode)
      const pending = count ?? 0
      result = {
        type: 'pending_vouchers',
        status: pending === 0 ? 'passed' : 'failed',
        actual: pending,
        details: { message: pending === 0 ? '无未过账凭证' : `${pending}张凭证未过账` },
      }
      break
    }
    case 'unconfirmed_settlements': {
      const { count } = await supabase
        .from('order_settlements')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'draft')
      const pending = count ?? 0
      result = {
        type: 'unconfirmed_settlements',
        status: pending === 0 ? 'passed' : 'warning',
        actual: pending,
        details: { message: pending === 0 ? '无未确认决算' : `${pending}张决算单未确认` },
      }
      break
    }
    case 'open_risk_events': {
      const { count } = await supabase
        .from('audit_findings')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open')
        .eq('severity', 'critical')
      const pending = count ?? 0
      result = {
        type: 'open_risk_events',
        status: pending === 0 ? 'passed' : 'failed',
        actual: pending,
        details: { message: pending === 0 ? '无未处理高危风险' : `${pending}个高危风险未处理` },
      }
      break
    }

    // --- Reuse gl-posting.ts ---
    case 'trial_balance': {
      const trialData = await getTrialBalance(periodCode)
      const totalDebit = trialData.reduce(
        (s: number, r: Record<string, unknown>) => s + ((r.period_debit as number) || 0),
        0
      )
      const totalCredit = trialData.reduce(
        (s: number, r: Record<string, unknown>) => s + ((r.period_credit as number) || 0),
        0
      )
      const variance = Math.abs(totalDebit - totalCredit)
      result = {
        type: 'trial_balance',
        status: variance < 0.01 ? 'passed' : 'failed',
        expected: totalDebit,
        actual: totalCredit,
        variance,
        details: {
          accountCount: trialData.length,
          message: variance < 0.01 ? '试算平衡' : `试算不平衡: 差额¥${variance.toFixed(2)}`,
        },
      }
      break
    }

    // --- Reuse fx-gains.ts ---
    case 'fx_revaluation': {
      // 重估汇率取自汇率主数据表（exchange_rates 最新一条）；取不到则不做重估，
      // 绝不臆造汇率生成 GL 草稿（旧实现写死 7.1）
      const sbRate = await createClient()
      const { data: rateRows } = await sbRate
        .from('exchange_rates')
        .select('rate')
        .eq('base_currency', 'USD').eq('quote_currency', 'CNY')
        .order('fetched_at', { ascending: false })
        .limit(1)
      const marketRate = Number(rateRows?.[0]?.rate) || 0
      if (!marketRate) {
        result = {
          type: 'fx_revaluation',
          status: 'warning',
          actual: 0,
          details: { message: '未执行汇兑重估：汇率主数据表(exchange_rates)无可用汇率，请财务先录入当期汇率' },
        }
        break
      }
      const fxResults = await calculateAllFxGains(marketRate)
      const totalGainLoss = fxResults.reduce((s, r) => s + r.fxGainLoss, 0)
      // 接入受控灰度：生成「汇兑重估」草稿凭证（非阻塞、幂等、待人工复核过账）
      let draftMsg = ''
      if (fxResults.length > 0) {
        try {
          const d = await createFxRevaluationDraft(fxResults, periodCode)
          draftMsg = d.created
            ? `；已生成汇兑重估草稿 ${d.voucherNo ?? ''}（待 GL 复核过账）`
            : `；未生成草稿：${d.reason ?? ''}`
        } catch (e) {
          draftMsg = `；草稿生成失败：${e instanceof Error ? e.message : '未知'}`
        }
      }
      result = {
        type: 'fx_revaluation',
        status: 'passed',
        actual: Math.round(totalGainLoss * 100) / 100,
        details: {
          orderCount: fxResults.length,
          totalGainLoss: Math.round(totalGainLoss * 100) / 100,
          rate: marketRate,
          message: (fxResults.length === 0
            ? '无USD订单需要重估'
            : `${fxResults.length}笔USD订单重估, 净损益¥${totalGainLoss.toFixed(2)}`) + draftMsg,
        },
      }
      break
    }

    default:
      result = {
        type: checkKey,
        status: 'warning',
        details: { message: `未知检查项: ${checkKey}` },
      }
  }

  // Get current user
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
  const userId = profiles?.[0]?.id

  // Persist result
  await supabase
    .from('period_close_checklists')
    .update({
      status: result.status === 'warning' ? 'passed' : result.status,
      result: result as unknown as Record<string, unknown>,
      executed_at: new Date().toISOString(),
      executed_by: userId,
    })
    .eq('period_code', periodCode)
    .eq('check_key', checkKey)

  return result
}

/**
 * Run all 12 checks sequentially. Returns aggregated result.
 *
 * Wave 3-C P1-E6 加固: 启动前 CAS 'open' → 'closing' 获取锁，
 * 结束（无论成功失败）恢复 'open'，仅人工 confirm 才转 'closed'。
 * 并发请求会因 CAS 失败而被拒绝。
 */
export async function runFullClosingChecklist(periodCode: string): Promise<ClosingResult> {
  const supabase = await createClient()

  // CAS 获锁
  const { error: lockErr } = await supabase.rpc('begin_period_close' as never, { p_period_code: periodCode } as never)
  if (lockErr) {
    // PERIOD_CLOSE_IN_PROGRESS / PERIOD_NOT_FOUND / PERIOD_ALREADY_CLOSED 等
    throw new Error(`关账锁获取失败: ${lockErr.message}`)
  }

  try {
    // Ensure initialized
    await initClosingChecklist(periodCode, 'month')

    for (const check of MONTH_CHECKS) {
      await executeClosingCheck(periodCode, check.key)
    }
  } finally {
    // 无论检查 pass/fail，统一恢复到 'open'（人工再决定是否进 'closed'）
    await supabase.rpc('end_period_close' as never, { p_period_code: periodCode, p_final_status: 'open' } as never)
  }

  // Reload from DB for consistent state
  const items = await getClosingStatus(periodCode)

  const passed = items.filter((i) => i.status === 'passed').length
  const failed = items.filter((i) => i.status === 'failed').length
  const skipped = items.filter((i) => i.status === 'skipped').length
  const overridden = items.filter((i) => i.status === 'overridden').length
  const pending = items.filter((i) => i.status === 'pending').length

  return {
    periodCode,
    totalChecks: items.length,
    passed,
    failed,
    skipped,
    overridden,
    pending,
    allClear: failed === 0 && pending === 0,
    items,
  }
}

/**
 * Override a failed/warning check with a reason and approval.
 */
export async function overrideCheck(
  periodCode: string,
  checkKey: string,
  reason: string,
  approvedBy: string
): Promise<void> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('period_close_checklists')
    .update({
      status: 'overridden',
      override_reason: reason,
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
    })
    .eq('period_code', periodCode)
    .eq('check_key', checkKey)

  if (error) throw new Error(`覆核失败: ${error.message}`)

  await recordTimelineEvent({
    entityType: 'period_close',
    entityId: periodCode,
    eventType: 'check_overridden',
    eventTitle: `结账检查被覆核: ${checkKey}`,
    eventDetail: { checkKey, reason },
    sourceType: 'user',
    actorId: approvedBy,
  })
}

/**
 * Finalize period close — only if all checks passed/overridden.
 */
// ============================================================
// 月度经营面板 — 锁账页一屏数字（与各业务页同 CNY 口径）
// ============================================================
export interface MonthEndPanel {
  periodCode: string
  orderCount: number
  settledCount: number
  unsettledCount: number
  revenueCny: number
  costCny: number
  profitCny: number
  marginPct: number
  arBalanceCny: number       // 当前应收余额（时点）
  apBalanceCny: number       // 当前应付余额（时点）
  collectedCny: number       // 本月回款
  collectionRatePct: number  // 本月回款 / 本月收入
}

const r2c = (n: number) => Math.round(n * 100) / 100
const toCnyRate = (currency: string | null | undefined, rate: number | null | undefined) =>
  (currency || 'CNY') === 'CNY' ? 1 : (Number(rate) || 1)

export async function getMonthlyClosingPanel(periodCode: string): Promise<MonthEndPanel> {
  const supabase = await createClient()
  const { data: period } = await supabase
    .from('accounting_periods').select('start_date, end_date').eq('period_code', periodCode).maybeSingle()
  const start = period?.start_date as string | undefined
  const end = period?.end_date as string | undefined

  // 本期订单（按下单日期落在期间内）；分页取全量防 1000 行截断。
  // 口径统一：收入/成本/利润/订单数只认「已审批+已关闭」订单（与应收页一致，草稿单不计）。
  const { data: orders } = await fetchAll<Record<string, unknown>>((from, to) => {
    let oq = supabase.from('budget_orders')
      .select('id, total_revenue, total_cost, currency, exchange_rate, order_date, status, ar_received_amount')
      .is('deleted_at', null).in('status', ['approved', 'closed'])
      .order('id', { ascending: true })
    if (start) oq = oq.gte('order_date', start)
    if (end) oq = oq.lte('order_date', end)
    return oq.range(from, to)
  })
  const orderList = orders || []
  const orderIds = orderList.map(o => o.id as string)

  // 决算覆盖
  const settledSet = new Set<string>()
  for (let i = 0; i < orderIds.length; i += 500) {
    const { data: st } = await supabase.from('order_settlements').select('budget_order_id').in('budget_order_id', orderIds.slice(i, i + 500))
    ;(st || []).forEach(s => settledSet.add(s.budget_order_id as string))
  }

  let revenueCny = 0, costCny = 0
  for (const o of orderList) {
    const rate = toCnyRate(o.currency as string, o.exchange_rate as number)
    revenueCny += (Number(o.total_revenue) || 0) * rate
    costCny += (Number(o.total_cost) || 0)  // total_cost 已是 CNY 口径（Phase 2 修复后）
  }
  revenueCny = r2c(revenueCny); costCny = r2c(costCny)
  const profitCny = r2c(revenueCny - costCny)

  // 本月回款（按回款日期落在期间内）；分页取全量
  const { data: receipts } = await fetchAll<Record<string, unknown>>((from, to) => {
    let pq = supabase.from('receivable_payments').select('amount_cny, received_at, id').is('voided_at', null).order('id', { ascending: true })
    if (start) pq = pq.gte('received_at', start)
    if (end) pq = pq.lte('received_at', end + 'T23:59:59')
    return pq.range(from, to)
  })
  const collectedCny = r2c((receipts || []).reduce((s, p) => s + (Number(p.amount_cny) || 0), 0))

  // 当前应收余额（时点）：已审批+已关闭订单（与应收页同口径），分页取全量
  const { data: allOrders } = await fetchAll<Record<string, unknown>>((from, to) => supabase.from('budget_orders')
    .select('id, total_revenue, currency, exchange_rate, ar_received_amount, status').is('deleted_at', null)
    .in('status', ['approved', 'closed']).order('id', { ascending: true }).range(from, to))
  const { data: allAlloc } = await fetchAll<Record<string, unknown>>((from, to) => supabase.from('receivable_payment_allocations')
    .select('budget_order_id, amount_cny').is('voided_at', null).order('id', { ascending: true }).range(from, to))
  const allocByOrder = new Map<string, number>()
  ;(allAlloc || []).forEach(a => allocByOrder.set(a.budget_order_id as string, (allocByOrder.get(a.budget_order_id as string) || 0) + (Number(a.amount_cny) || 0)))
  let arBalanceCny = 0
  for (const o of allOrders || []) {
    const rate = toCnyRate(o.currency as string, o.exchange_rate as number)
    const contract = (Number(o.total_revenue) || 0) * rate
    const received = allocByOrder.get(o.id as string) ?? (Number(o.ar_received_amount) || 0) * rate
    arBalanceCny += Math.max(0, contract - received)
  }
  // 当前应付余额：按供应商正向汇总（与应付页同口径——多付的供应商不冲减其他供应商），分页取全量
  const { data: costAll } = await fetchAll<Record<string, unknown>>((from, to) => supabase.from('cost_items')
    .select('amount, currency, exchange_rate, supplier, id').is('deleted_at', null).order('id', { ascending: true }).range(from, to))
  const { data: payAll } = await fetchAll<Record<string, unknown>>((from, to) => supabase.from('supplier_payments')
    .select('amount, supplier_name, id').is('deleted_at', null).order('id', { ascending: true }).range(from, to))
  const costBySupplier = new Map<string, number>()
  ;(costAll || []).forEach(c => {
    const k = normalizeSupplierName(c.supplier as string) || '未指定'
    costBySupplier.set(k, (costBySupplier.get(k) || 0) + (Number(c.amount) || 0) * toCnyRate(c.currency as string, c.exchange_rate as number))
  })
  const paidBySupplier = new Map<string, number>()
  ;(payAll || []).forEach(p => {
    const k = normalizeSupplierName(p.supplier_name as string) || '未指定'
    paidBySupplier.set(k, (paidBySupplier.get(k) || 0) + (Number(p.amount) || 0))
  })
  let apBalanceCny = 0
  for (const [sup, cost] of costBySupplier) {
    apBalanceCny += Math.max(0, cost - (paidBySupplier.get(sup) || 0))
  }
  apBalanceCny = r2c(apBalanceCny)

  return {
    periodCode,
    orderCount: orderList.length,
    settledCount: orderIds.filter(id => settledSet.has(id)).length,
    unsettledCount: orderIds.filter(id => !settledSet.has(id)).length,
    revenueCny, costCny, profitCny,
    marginPct: revenueCny > 0 ? r2c((profitCny / revenueCny) * 100) : 0,
    arBalanceCny: r2c(arBalanceCny),
    apBalanceCny,
    collectedCny,
    collectionRatePct: revenueCny > 0 ? r2c((collectedCny / revenueCny) * 100) : 0,
  }
}

// ============================================================
// 解锁审批：财务经理发起 → admin 批准
// ============================================================
export async function requestPeriodReopen(periodCode: string, reason: string, actorId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: hit, error } = await supabase.from('accounting_periods')
    .update({ reopen_requested_by: actorId, reopen_requested_at: new Date().toISOString(), reopen_reason: reason })
    .eq('period_code', periodCode).eq('status', 'closed').select('id')
  if (error) return { success: false, error: error.message }
  if (!hit || hit.length === 0) return { success: false, error: '该期间不是已关账状态，无法申请解锁' }
  await recordTimelineEvent({
    entityType: 'period_close', entityId: periodCode, eventType: 'reopen_requested',
    eventTitle: `申请解锁会计期间 ${periodCode}`, eventDetail: { reason }, sourceType: 'user', actorId,
  })
  return { success: true }
}

export async function approvePeriodReopen(periodCode: string, actorId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: period } = await supabase.from('accounting_periods').select('reopen_requested_at').eq('period_code', periodCode).maybeSingle()
  if (!period?.reopen_requested_at) return { success: false, error: '该期间无待批准的解锁申请' }
  const { error } = await supabase.from('accounting_periods')
    .update({ status: 'open', closed_by: null, closed_at: null, reopen_requested_by: null, reopen_requested_at: null, reopen_reason: null })
    .eq('period_code', periodCode)
  if (error) return { success: false, error: error.message }
  await recordTimelineEvent({
    entityType: 'period_close', entityId: periodCode, eventType: 'reopen_approved',
    eventTitle: `批准解锁会计期间 ${periodCode}`, eventDetail: {}, sourceType: 'user', actorId,
  })
  return { success: true }
}

export async function finalizePeriodClose(
  periodCode: string,
  closedBy: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  // Check all items are resolved
  const items = await getClosingStatus(periodCode)
  const blocking = items.filter(
    (i) => i.status === 'failed' || i.status === 'pending'
  )
  if (blocking.length > 0) {
    const blockingLabels = blocking.map((b) => b.checkLabel).join(', ')
    return {
      success: false,
      error: `以下检查项未通过: ${blockingLabels}`,
    }
  }

  // Close accounting period
  const { error: periodErr } = await supabase
    .from('accounting_periods')
    .update({
      status: 'closed',
      closed_by: closedBy,
      closed_at: new Date().toISOString(),
      close_notes: `期间${periodCode}已关闭, 共${items.length}项检查`,
    })
    .eq('period_code', periodCode)

  if (periodErr) {
    return { success: false, error: `关闭期间失败: ${periodErr.message}` }
  }

  // 锁账产物：固化月度经营面板为快照（老板月报数据源）
  try {
    const panel = await getMonthlyClosingPanel(periodCode)
    await supabase.from('month_end_snapshots').upsert(
      { period_code: periodCode, panel: panel as unknown as Record<string, unknown>, closed_by: closedBy, closed_at: new Date().toISOString() },
      { onConflict: 'period_code' }
    )
  } catch (e) { console.error('[closing] 月结快照失败:', e) }

  await recordTimelineEvent({
    entityType: 'period_close',
    entityId: periodCode,
    eventType: 'period_closed',
    eventTitle: `会计期间 ${periodCode} 已关闭`,
    eventDetail: {
      passed: items.filter((i) => i.status === 'passed').length,
      overridden: items.filter((i) => i.status === 'overridden').length,
    },
    sourceType: 'user',
    actorId: closedBy,
  })

  return { success: true }
}

/**
 * Year-end carry forward: close P&L accounts to retained earnings.
 * Creates a closing journal entry transferring net income to equity.
 */
export async function yearEndCarryForward(year: number): Promise<{ voucherNo: string }> {
  const supabase = await createClient()
  const periodCode = `${year}-12`

  // Get full year P&L by summing all 12 months
  let totalRevenue = 0
  let totalExpense = 0
  for (let m = 1; m <= 12; m++) {
    const pc = `${year}-${String(m).padStart(2, '0')}`
    const pl = await getProfitAndLoss(pc)
    totalRevenue += pl.revenue
    totalExpense += pl.expense
  }

  const netIncome = Math.round((totalRevenue - totalExpense) * 100) / 100

  if (Math.abs(netIncome) < 0.01) {
    return { voucherNo: '' }
  }

  // Get current user
  const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
  const createdBy = profiles?.[0]?.id

  // Build carry-forward journal lines
  // Debit: Revenue accounts (to zero them out)
  // Credit: Expense accounts (to zero them out)
  // Net difference goes to Retained Earnings (account 3131)
  const lines: { account_code: string; description: string; debit: number; credit: number }[] = []

  if (totalRevenue > 0) {
    lines.push({
      account_code: '500101',
      description: `${year}年收入结转`,
      debit: totalRevenue,
      credit: 0,
    })
  }
  if (totalExpense > 0) {
    lines.push({
      account_code: '540101',
      description: `${year}年成本结转`,
      debit: 0,
      credit: totalExpense,
    })
  }

  // Net income to retained earnings
  if (netIncome > 0) {
    lines.push({
      account_code: '3131',
      description: `${year}年未分配利润`,
      debit: 0,
      credit: netIncome,
    })
  } else {
    lines.push({
      account_code: '3131',
      description: `${year}年未分配利润(亏损)`,
      debit: Math.abs(netIncome),
      credit: 0,
    })
  }

  // Ensure debit/credit balance
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0)
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0)

  // Atomic: header + lines in one DB transaction via RPC
  const linesJson = lines.map(l => ({
    account_code: l.account_code,
    description: l.description,
    debit: l.debit,
    credit: l.credit,
    currency: 'CNY',
    exchange_rate: 1,
  }))

  const { data: rpcResult, error } = await supabase.rpc('create_journal_atomic', {
    p_period_code: periodCode,
    p_date: `${year}-12-31`,
    p_description: `${year}年末损益结转 — 利润结转至未分配利润`,
    p_source_type: 'year_end_close',
    p_source_id: null,
    p_total_debit: Math.round(totalDebit * 100) / 100,
    p_total_credit: Math.round(totalCredit * 100) / 100,
    p_voucher_type: 'closing',
    p_created_by: createdBy ?? null,
    p_lines: linesJson,
  })

  if (error) throw new Error(`年末结转凭证创建失败: ${error.message}`)

  const voucherNo = (rpcResult as { voucher_no: string } | null)?.voucher_no ?? ''

  await recordTimelineEvent({
    entityType: 'period_close',
    entityId: periodCode,
    eventType: 'year_end_carry_forward',
    eventTitle: `${year}年末损益结转完成`,
    eventDetail: {
      totalRevenue,
      totalExpense,
      netIncome,
      voucherNo,
    },
    sourceType: 'system',
  })

  return { voucherNo }
}

/**
 * Get current closing status for a period.
 */
export async function getClosingStatus(periodCode: string): Promise<ClosingCheckItem[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('period_close_checklists')
    .select('*')
    .eq('period_code', periodCode)
    .order('check_order')

  if (error) throw new Error(`获取结账状态失败: ${error.message}`)

  return (data || []).map(mapRow)
}
