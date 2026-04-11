// 控制中心总览 API — 聚合所有6大引擎数据
// GET /api/control-center/overview
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { getAuditFindings } from '@/lib/engines/audit-engine'
import { getActiveFreezes } from '@/lib/engines/freeze-engine'
import { getTrustDashboard } from '@/lib/engines/trust-engine'
import { getClosingStatus } from '@/lib/engines/closing-engine'
import { getRecentEvents } from '@/lib/engines/timeline-engine'
import { generateExplanations, type OverviewData } from '@/lib/engines/explanation-engine'
import { getPendingRiskEvents, getBudgetOrders, getProfitSummary, getMonthlyProfitData } from '@/lib/supabase/queries'
import { getPendingTasks, getAutomationHealth } from '@/lib/engines/orchestration-engine'
import { getRecentOverrides } from '@/lib/engines/override-engine'

export async function GET() {
  try {
    const auth = await requireAuth()
    if (!auth.authenticated) return auth.error!

    // 当前月结期间代码
    const now = new Date()
    const periodCode = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

    // 并行获取所有引擎数据
    const [
      auditFindings,
      activeFreezes,
      trustDashboard,
      closingChecks,
      recentEvents,
      riskEvents,
      allOrders,
      profitSummary,
      monthlyProfit,
      pendingTasks,
      automationHealth,
      recentOverrides,
    ] = await Promise.all([
      getAuditFindings({ status: 'open' }),
      getActiveFreezes(),
      getTrustDashboard(),
      getClosingStatus(periodCode).catch(() => []),
      getRecentEvents(20),
      getPendingRiskEvents(),
      getBudgetOrders(),
      getProfitSummary(),
      getMonthlyProfitData(),
      getPendingTasks().catch(() => []),
      getAutomationHealth().catch(() => ({ score: 0, successRate: 0, conflictRate: 0, overrideRate: 0, dryRunPending: 0, totalExecutions: 0, riskiestRules: [], trend: 'stable' as const })),
      getRecentOverrides(5).catch(() => []),
    ])

    // ---- 计算聚合指标 ----

    // 稽核
    const criticalFindings = auditFindings.filter(f => f.severity === 'critical').length
    const warningFindings = auditFindings.filter(f => f.severity === 'warning').length

    // 冻结
    const freezeCount = activeFreezes.length

    // 信任
    const lowTrustCount = trustDashboard.lowTrust.length
    const trustTotal = trustDashboard.summary.total
    const trustByLevel = trustDashboard.summary.byLevel
    const trustAvg = trustTotal > 0
      ? Math.round(
          Object.entries(trustByLevel).reduce((sum, [level, count]) => {
            const scores: Record<string, number> = { T0: 10, T1: 30, T2: 50, T3: 70, T4: 85, T5: 95 }
            return sum + (scores[level] || 50) * (count as number)
          }, 0) / trustTotal
        )
      : 50

    // 待处理
    const pendingApprovals = allOrders.filter(o => o.status === 'pending_review').length
    const pendingPayments = allOrders.filter(o => o.status === 'approved').length
    const openRiskEvents = riskEvents.length

    // 月结
    const closingPending = closingChecks.filter(c => c.status === 'pending' || c.status === 'failed').length
    const closingTotal = closingChecks.length

    // GL平衡（从月结检查中读取）
    const glCheck = closingChecks.find(c => c.checkKey === 'gl_balance')
    const glBalanced = glCheck ? glCheck.status === 'passed' : true

    // 高风险订单（利润率<10%）
    const highRiskOrders = allOrders.filter(o => {
      if (o.total_revenue <= 0) return false
      const margin = ((o.total_revenue - o.total_cost) / o.total_revenue) * 100
      return margin < 10
    }).length

    // 回滚/拒绝计数（从信任面板获取）
    const rollbackCount = trustDashboard.summary.recentDowngrades
    const rejectCount = trustDashboard.recentChanges.filter(c => c.to === 'T0' || c.to === 'T1').length

    // 利润趋势（最近两个月对比）
    let profitTrend = 0
    if (monthlyProfit.length >= 2) {
      const last = monthlyProfit[monthlyProfit.length - 1]
      const prev = monthlyProfit[monthlyProfit.length - 2]
      if (prev.profit !== 0) {
        profitTrend = Math.round(((last.profit - prev.profit) / Math.abs(prev.profit)) * 1000) / 10
      }
    }

    // 构造 OverviewData 供解释引擎使用
    const overviewData: OverviewData = {
      criticalFindings,
      warningFindings,
      activeFreezes: freezeCount,
      lowTrustCount,
      highRiskOrders,
      highRiskCustomers: 0,
      pendingApprovals,
      pendingPayments,
      blockedActions: 0,
      openRiskEvents,
      closingPending,
      closingTotal,
      glBalanced,
      trustAvg,
      rollbackCount,
      rejectCount,
      profitTrend,
      trustDowngrades: trustDashboard.summary.recentDowngrades,
      recentFreezes: freezeCount,
    }

    // 生成解释
    const explanations = generateExplanations(overviewData)

    // KPI
    const kpi = {
      revenue: profitSummary.total_revenue,
      profit: profitSummary.total_profit,
      margin: profitSummary.avg_margin,
      orderCount: profitSummary.order_count,
      cashflow: 0,
      riskOrders: highRiskOrders,
      pendingApprovals,
      freezes: freezeCount,
      trustAvg,
    }

    return NextResponse.json({
      risk: {
        criticalFindings,
        warningFindings,
        activeFreezes: freezeCount,
        lowTrustCount,
        highRiskOrders,
      },
      pending: {
        pendingApprovals,
        pendingPayments,
        blockedActions: 0,
        openRiskEvents,
        closingPending,
        closingTotal,
        auditOpen: auditFindings.length,
      },
      health: {
        glBalanced,
        trustAvg,
        rollbackCount,
        rejectCount,
      },
      trends: {
        profitTrend,
        trustDowngrades: trustDashboard.summary.recentDowngrades,
        monthlyProfit,
      },
      explanations,
      kpi,
      trust: {
        byLevel: trustByLevel,
        lowTrust: trustDashboard.lowTrust,
        recentChanges: trustDashboard.recentChanges,
      },
      timeline: recentEvents.slice(0, 10),
      closing: {
        periodCode,
        items: closingChecks,
        pending: closingPending,
        total: closingTotal,
      },
      freezes: activeFreezes.slice(0, 10),
      tasks: {
        pending: pendingTasks.filter((t: Record<string, unknown>) => t.status === 'pending').length,
        escalated: pendingTasks.filter((t: Record<string, unknown>) => t.status === 'escalated').length,
        blocked: pendingTasks.filter((t: Record<string, unknown>) => t.status === 'blocked').length,
        items: pendingTasks.slice(0, 10),
      },
      automationHealth,
      recentOverrides,
    })
  } catch (error) {
    console.error('[overview GET]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取控制中心总览失败' },
      { status: 500 }
    )
  }
}
