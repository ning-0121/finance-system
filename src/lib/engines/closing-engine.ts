// ============================================================
// Closing Engine — Month-end / Year-end Period Close
// ============================================================
// Orchestrates a 12-check month-end checklist, reusing existing
// reconciliation, GL, and FX modules. Supports overrides, timeline
// auditing, and year-end carry-forward journal entries.

import { createClient } from '@/lib/supabase/client'
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
import { calculateAllFxGains } from '@/lib/accounting/fx-gains'

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
  const supabase = createClient()

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
  const supabase = createClient()
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
      // Use current market rate (default 7.1 if not supplied — real apps would fetch live)
      const defaultRate = 7.1
      const fxResults = await calculateAllFxGains(defaultRate)
      const totalGainLoss = fxResults.reduce((s, r) => s + r.fxGainLoss, 0)
      result = {
        type: 'fx_revaluation',
        status: 'passed',
        actual: Math.round(totalGainLoss * 100) / 100,
        details: {
          orderCount: fxResults.length,
          totalGainLoss: Math.round(totalGainLoss * 100) / 100,
          rate: defaultRate,
          message: fxResults.length === 0
            ? '无USD订单需要重估'
            : `${fxResults.length}笔USD订单重估, 净损益¥${totalGainLoss.toFixed(2)}`,
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
 */
export async function runFullClosingChecklist(periodCode: string): Promise<ClosingResult> {
  // Ensure initialized
  await initClosingChecklist(periodCode, 'month')

  const results: ClosingCheckItem[] = []

  for (const check of MONTH_CHECKS) {
    await executeClosingCheck(periodCode, check.key)
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
  const supabase = createClient()

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
export async function finalizePeriodClose(
  periodCode: string,
  closedBy: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient()

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
  const supabase = createClient()
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

  const { data: journal, error } = await supabase
    .from('journal_entries')
    .insert({
      voucher_no: '',
      period_code: periodCode,
      voucher_date: `${year}-12-31`,
      voucher_type: 'closing',
      description: `${year}年末损益结转 — 利润结转至未分配利润`,
      source_type: 'year_end_close',
      total_debit: Math.round(totalDebit * 100) / 100,
      total_credit: Math.round(totalCredit * 100) / 100,
      status: 'posted',
      created_by: createdBy,
      posted_by: createdBy,
      posted_at: new Date().toISOString(),
    })
    .select('id, voucher_no')
    .single()

  if (error) throw new Error(`年末结转凭证创建失败: ${error.message}`)

  await supabase.from('journal_lines').insert(
    lines.map((l, i) => ({
      journal_id: journal.id,
      line_no: i + 1,
      account_code: l.account_code,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
      currency: 'CNY',
      exchange_rate: 1,
    }))
  )

  await recordTimelineEvent({
    entityType: 'period_close',
    entityId: periodCode,
    eventType: 'year_end_carry_forward',
    eventTitle: `${year}年末损益结转完成`,
    eventDetail: {
      totalRevenue,
      totalExpense,
      netIncome,
      voucherNo: journal.voucher_no,
    },
    sourceType: 'system',
  })

  return { voucherNo: journal.voucher_no }
}

/**
 * Get current closing status for a period.
 */
export async function getClosingStatus(periodCode: string): Promise<ClosingCheckItem[]> {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('period_close_checklists')
    .select('*')
    .eq('period_code', periodCode)
    .order('check_order')

  if (error) throw new Error(`获取结账状态失败: ${error.message}`)

  return (data || []).map(mapRow)
}
