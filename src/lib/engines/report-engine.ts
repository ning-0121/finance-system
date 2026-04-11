// ============================================================
// Report Engine — 结构化日报/周报生成
// 复用已有引擎函数，聚合KPI、风险、信任、任务等模块数据
// ============================================================

import { createClient } from '@/lib/supabase/client'
import { getProfitSummary, getMonthlyProfitData, getPendingRiskEvents } from '@/lib/supabase/queries'
import { getTrustDashboard } from './trust-engine'
import { getActiveFreezes } from './freeze-engine'
import { getAuditFindings } from './audit-engine'
import { getClosingStatus } from './closing-engine'
import { getPendingTasks } from './orchestration-engine'
import { generateExplanations, type OverviewData } from './explanation-engine'

// --------------- Types ---------------

export interface DailyReport {
  date: string
  role: string
  kpi: { revenue: number; profit: number; margin: number; orderCount: number }
  risks: { open: number; critical: number; newToday: number }
  trust: { avgScore: number; downgrades: number; lowCount: number }
  freeze: { active: number; newToday: number }
  tasks: { pending: number; escalated: number; resolvedToday: number }
  closing: { completed: number; total: number; periodCode: string }
  audit: { openFindings: number; criticalFindings: number }
  explanations: { text: string; severity: string; category: string }[]
  suggestedActions: string[]
}

// --------------- Generate Daily Report ---------------

export async function generateDailyReport(role?: string): Promise<DailyReport> {
  const supabase = createClient()
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const reportRole = role || 'finance_manager'

  // 1. KPI — profit summary
  const profitSummary = await getProfitSummary()
  const monthlyData = await getMonthlyProfitData()

  // Calculate profit trend (compare last 2 months)
  let profitTrend = 0
  if (Array.isArray(monthlyData) && monthlyData.length >= 2) {
    const current = monthlyData[monthlyData.length - 1]
    const previous = monthlyData[monthlyData.length - 2]
    if (previous.profit !== 0) {
      profitTrend = ((current.profit - previous.profit) / Math.abs(previous.profit)) * 100
    }
  }

  // 2. Risk events
  const riskEvents = await getPendingRiskEvents()
  const todayStart = new Date(todayStr).toISOString()
  const newTodayRisks = riskEvents.filter(
    (r) => (r.created_at as string) >= todayStart
  ).length

  // 3. Trust dashboard
  const trustDashboard = await getTrustDashboard()
  const totalTrustEntities = trustDashboard.summary.total
  const avgTrustScore = totalTrustEntities > 0
    ? await computeAvgTrustScore()
    : 0

  // 4. Active freezes
  const activeFreezes = await getActiveFreezes()
  const newFreezes = activeFreezes.filter(
    (f) => (f.frozen_at as string) >= todayStart
  ).length

  // 5. Tasks
  const pendingTasks = await getPendingTasks(reportRole === 'all' ? undefined : reportRole)
  const escalatedTasks = pendingTasks.filter((t) => t.status === 'escalated')

  // Count resolved today
  const { data: resolvedToday } = await supabase
    .from('orchestration_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'resolved')
    .gte('resolved_at', todayStart)

  // 6. Closing status for current period
  const periodCode = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  let closingCompleted = 0
  let closingTotal = 0
  try {
    const closingItems = await getClosingStatus(periodCode)
    closingTotal = closingItems.length
    closingCompleted = closingItems.filter(
      (i) => i.status === 'passed' || i.status === 'overridden' || i.status === 'skipped'
    ).length
  } catch {
    // Period may not be initialized yet
  }

  // 7. Audit findings
  let openFindings = 0
  let criticalFindings = 0
  try {
    const allOpen = await getAuditFindings({ status: 'open' })
    openFindings = allOpen.length
    criticalFindings = allOpen.filter((f) => f.severity === 'critical').length
  } catch {
    // Audit table may not exist
  }

  // 8. Build OverviewData for explanations
  const { count: pendingApprovals } = await supabase
    .from('budget_orders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending_review')

  const { count: pendingPayments } = await supabase
    .from('payable_records')
    .select('id', { count: 'exact', head: true })
    .eq('payment_status', 'pending_approval')

  const { count: blockedActions } = await supabase
    .from('document_actions')
    .select('id', { count: 'exact', head: true })
    .eq('decision', 'pending')

  // Check GL balance
  let glBalanced = true
  try {
    const { data: glCheck } = await supabase
      .from('journal_entries')
      .select('total_debit, total_credit')
      .eq('status', 'posted')

    if (glCheck?.length) {
      const totalDebit = glCheck.reduce((s, e) => s + ((e.total_debit as number) || 0), 0)
      const totalCredit = glCheck.reduce((s, e) => s + ((e.total_credit as number) || 0), 0)
      glBalanced = Math.abs(totalDebit - totalCredit) < 0.01
    }
  } catch {
    // GL tables may not exist
  }

  // Count rollbacks and rejects in last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { count: rollbackCount } = await supabase
    .from('entity_timeline')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'rollback')
    .gte('created_at', sevenDaysAgo)

  const { count: rejectCount } = await supabase
    .from('entity_timeline')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'rejected')
    .gte('created_at', sevenDaysAgo)

  // High risk orders (margin < 10%)
  const { count: highRiskOrders } = await supabase
    .from('budget_orders')
    .select('id', { count: 'exact', head: true })
    .in('status', ['approved', 'closed'])
    .lt('estimated_margin', 10)

  // High risk customers
  const { count: highRiskCustomers } = await supabase
    .from('customer_financial_profiles')
    .select('id', { count: 'exact', head: true })
    .in('risk_level', ['C', 'D', 'E'])

  // Cashflow gap
  let cashflowGap: number | undefined
  try {
    const { data: cfData } = await supabase
      .from('cashflow_forecasts')
      .select('net_cashflow')
      .in('warning_level', ['danger', 'critical'])
      .order('net_cashflow', { ascending: true })
      .limit(1)

    if (cfData?.length) {
      cashflowGap = cfData[0].net_cashflow as number
    }
  } catch {
    // Table may not exist
  }

  const overviewData: OverviewData = {
    criticalFindings,
    warningFindings: openFindings - criticalFindings,
    activeFreezes: activeFreezes.length,
    lowTrustCount: trustDashboard.lowTrust.length,
    highRiskOrders: highRiskOrders ?? 0,
    highRiskCustomers: highRiskCustomers ?? 0,
    pendingApprovals: pendingApprovals ?? 0,
    pendingPayments: pendingPayments ?? 0,
    blockedActions: blockedActions ?? 0,
    openRiskEvents: riskEvents.length,
    closingPending: closingTotal - closingCompleted,
    closingTotal,
    glBalanced,
    trustAvg: avgTrustScore,
    rollbackCount: rollbackCount ?? 0,
    rejectCount: rejectCount ?? 0,
    profitTrend,
    trustDowngrades: trustDashboard.summary.recentDowngrades,
    recentFreezes: newFreezes,
    cashflowGap,
  }

  const explanations = generateExplanations(overviewData)

  // Build suggested actions from explanations with actionHref
  const suggestedActions = explanations
    .filter((e) => e.actionHref)
    .map((e) => `[${e.category}] ${e.text}`)
    .slice(0, 8) // Limit to top 8

  return {
    date: todayStr,
    role: reportRole,
    kpi: {
      revenue: profitSummary.total_revenue,
      profit: profitSummary.total_profit,
      margin: profitSummary.avg_margin,
      orderCount: profitSummary.order_count,
    },
    risks: {
      open: riskEvents.length,
      critical: criticalFindings,
      newToday: newTodayRisks,
    },
    trust: {
      avgScore: avgTrustScore,
      downgrades: trustDashboard.summary.recentDowngrades,
      lowCount: trustDashboard.lowTrust.length,
    },
    freeze: {
      active: activeFreezes.length,
      newToday: newFreezes,
    },
    tasks: {
      pending: pendingTasks.length,
      escalated: escalatedTasks.length,
      resolvedToday: (resolvedToday as unknown as number) ?? 0,
    },
    closing: {
      completed: closingCompleted,
      total: closingTotal,
      periodCode,
    },
    audit: {
      openFindings,
      criticalFindings,
    },
    explanations: explanations.map((e) => ({
      text: e.text,
      severity: e.severity,
      category: e.category,
    })),
    suggestedActions,
  }
}

// --------------- Format Report as Markdown ---------------

export async function formatReportAsMarkdown(report: DailyReport): Promise<string> {
  const lines: string[] = []

  lines.push(`# 财务日报 ${report.date}`)
  lines.push(`> 角色: ${report.role}`)
  lines.push('')

  // KPI Section
  lines.push('## 核心指标')
  lines.push(`| 指标 | 数值 |`)
  lines.push(`| --- | --- |`)
  lines.push(`| 总收入 | ¥${report.kpi.revenue.toLocaleString()} |`)
  lines.push(`| 总利润 | ¥${report.kpi.profit.toLocaleString()} |`)
  lines.push(`| 平均毛利率 | ${report.kpi.margin}% |`)
  lines.push(`| 订单数 | ${report.kpi.orderCount} |`)
  lines.push('')

  // Risk Section
  lines.push('## 风险状态')
  lines.push(`- 待处理风险: ${report.risks.open} 个`)
  lines.push(`- 严重异常: ${report.risks.critical} 个`)
  lines.push(`- 今日新增: ${report.risks.newToday} 个`)
  lines.push('')

  // Trust Section
  lines.push('## 信任系统')
  lines.push(`- 平均信任分: ${report.trust.avgScore}`)
  lines.push(`- 近期降级: ${report.trust.downgrades} 次`)
  lines.push(`- 低信任实体: ${report.trust.lowCount} 个`)
  lines.push('')

  // Freeze Section
  if (report.freeze.active > 0) {
    lines.push('## 冻结状态')
    lines.push(`- 当前冻结: ${report.freeze.active} 个`)
    lines.push(`- 今日新增: ${report.freeze.newToday} 个`)
    lines.push('')
  }

  // Task Section
  lines.push('## 任务情况')
  lines.push(`- 待处理: ${report.tasks.pending} 个`)
  lines.push(`- 已升级: ${report.tasks.escalated} 个`)
  lines.push(`- 今日已解决: ${report.tasks.resolvedToday} 个`)
  lines.push('')

  // Closing Section
  if (report.closing.total > 0) {
    lines.push('## 月结进度')
    lines.push(`- 期间: ${report.closing.periodCode}`)
    lines.push(`- 完成: ${report.closing.completed}/${report.closing.total}`)
    lines.push('')
  }

  // Audit Section
  if (report.audit.openFindings > 0) {
    lines.push('## 稽核发现')
    lines.push(`- 待处理: ${report.audit.openFindings} 个`)
    lines.push(`- 严重级别: ${report.audit.criticalFindings} 个`)
    lines.push('')
  }

  // Explanations
  if (report.explanations.length > 0) {
    lines.push('## 系统分析')
    for (const exp of report.explanations) {
      const icon = exp.severity === 'critical' ? '[!]' : exp.severity === 'warning' ? '[*]' : '[-]'
      lines.push(`${icon} ${exp.text}`)
    }
    lines.push('')
  }

  // Suggested Actions
  if (report.suggestedActions.length > 0) {
    lines.push('## 建议操作')
    for (const action of report.suggestedActions) {
      lines.push(`- ${action}`)
    }
    lines.push('')
  }

  lines.push(`---`)
  lines.push(`*报告生成时间: ${new Date().toLocaleString('zh-CN')}*`)

  return lines.join('\n')
}

// --------------- Helpers ---------------

async function computeAvgTrustScore(): Promise<number> {
  const supabase = createClient()

  const { data: scores } = await supabase
    .from('automation_trust_scores')
    .select('trust_score')

  if (!scores?.length) return 0

  const sum = scores.reduce((s, r) => s + ((r.trust_score as number) || 0), 0)
  return Math.round((sum / scores.length) * 10) / 10
}
