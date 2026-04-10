// ============================================================
// 熔断机制 Agent — 自动暂停出货 + 信用调整 + CEO升级
// 所有熔断动作自动通知CEO(Su)，不自动执行
// ============================================================

import type { FinancialAgentAction, CustomerFinancialProfile } from '@/lib/types/agent'

export type BreakerTrigger =
  | 'overdue_60_days'         // 逾期超60天
  | 'overdue_exceed_credit'   // 欠款超信用额度
  | 'bad_debt_high'           // 坏账评分超阈值
  | 'profit_negative'         // 订单亏损
  | 'cashflow_critical'       // 现金流危急
  | 'dependency_too_high'     // 单一客户依赖过高

export interface BreakerDecision {
  trigger: BreakerTrigger
  severity: 'warning' | 'critical'
  customer_name: string
  title: string
  description: string
  recommended_actions: RecommendedAction[]
  notify_ceo: boolean
  auto_execute: boolean  // 始终false，需CEO确认
}

export interface RecommendedAction {
  action: string
  label: string
  impact: string
  requires_ceo_approval: boolean
}

// --- 主检测函数 ---
export function runCircuitBreakerChecks(
  customer: CustomerFinancialProfile,
  context: {
    hasNegativeProfitOrders?: boolean
    currentCashBalance?: number
    totalCustomerRevenue?: number
    companyTotalRevenue?: number
  } = {}
): BreakerDecision[] {
  const decisions: BreakerDecision[] = []

  // 1. 逾期超60天
  if (customer.avg_payment_days > 60 && customer.overdue_rate > 0.3) {
    decisions.push({
      trigger: 'overdue_60_days',
      severity: 'critical',
      customer_name: customer.customer_name,
      title: `🚨 ${customer.customer_name} 严重逾期`,
      description: `平均付款天数${customer.avg_payment_days}天，逾期率${(customer.overdue_rate * 100).toFixed(0)}%，未付余额 $${customer.total_outstanding.toLocaleString()}`,
      recommended_actions: [
        { action: 'hold_shipment', label: '暂停该客户所有出货', impact: '防止进一步损失', requires_ceo_approval: true },
        { action: 'reduce_credit', label: `信用额度降至 $${Math.round(customer.credit_limit * 0.3).toLocaleString()}`, impact: '限制未来订单规模', requires_ceo_approval: true },
        { action: 'require_prepayment', label: '后续订单要求100%预付', impact: '消除回款风险', requires_ceo_approval: true },
      ],
      notify_ceo: true,
      auto_execute: false,
    })
  }

  // 2. 欠款超信用额度
  if (customer.credit_limit > 0 && customer.total_outstanding > customer.credit_limit) {
    const overAmount = customer.total_outstanding - customer.credit_limit
    decisions.push({
      trigger: 'overdue_exceed_credit',
      severity: 'critical',
      customer_name: customer.customer_name,
      title: `🚨 ${customer.customer_name} 超信用额度 $${overAmount.toLocaleString()}`,
      description: `信用额度 $${customer.credit_limit.toLocaleString()}，当前欠款 $${customer.total_outstanding.toLocaleString()}`,
      recommended_actions: [
        { action: 'hold_new_orders', label: '暂停接受新订单', impact: '控制风险敞口', requires_ceo_approval: true },
        { action: 'hold_shipment', label: '暂停在途出货', impact: '等待回款后再放行', requires_ceo_approval: true },
      ],
      notify_ceo: true,
      auto_execute: false,
    })
  }

  // 3. 坏账评分超50
  if (customer.bad_debt_score > 50) {
    decisions.push({
      trigger: 'bad_debt_high',
      severity: customer.bad_debt_score > 70 ? 'critical' : 'warning',
      customer_name: customer.customer_name,
      title: `⚠️ ${customer.customer_name} 坏账风险高 (评分${customer.bad_debt_score})`,
      description: `扣款${customer.deduction_frequency}次，发票争议${customer.invoice_dispute_frequency}次，延迟确认${customer.late_confirmation_frequency}次`,
      recommended_actions: [
        { action: 'risk_upgrade', label: `风险等级升至 ${customer.bad_debt_score > 70 ? 'E' : 'D'}`, impact: '强制预付款', requires_ceo_approval: true },
        { action: 'reduce_credit', label: '信用额度降低50%', impact: '限制风险敞口', requires_ceo_approval: true },
      ],
      notify_ceo: true,
      auto_execute: false,
    })
  }

  // 4. 订单亏损
  if (context.hasNegativeProfitOrders) {
    decisions.push({
      trigger: 'profit_negative',
      severity: 'warning',
      customer_name: customer.customer_name,
      title: `⚠️ ${customer.customer_name} 存在亏损订单`,
      description: `该客户有订单利润为负，平均利润率${customer.average_order_profit_rate}%`,
      recommended_actions: [
        { action: 'review_pricing', label: '复盘定价策略', impact: '避免持续亏损', requires_ceo_approval: false },
        { action: 'increase_price', label: '下次报价提高8-10%', impact: '恢复合理利润', requires_ceo_approval: false },
      ],
      notify_ceo: true,
      auto_execute: false,
    })
  }

  // 5. 单一客户依赖过高 (>40%)
  if (context.companyTotalRevenue && context.totalCustomerRevenue) {
    const dependencyRatio = context.totalCustomerRevenue / context.companyTotalRevenue
    if (dependencyRatio > 0.4) {
      decisions.push({
        trigger: 'dependency_too_high',
        severity: 'warning',
        customer_name: customer.customer_name,
        title: `⚠️ ${customer.customer_name} 依赖度过高 (${(dependencyRatio * 100).toFixed(0)}%)`,
        description: `该客户营收占公司总营收${(dependencyRatio * 100).toFixed(0)}%，单一客户依赖风险`,
        recommended_actions: [
          { action: 'diversify', label: '加速开发新客户', impact: '降低单一客户风险', requires_ceo_approval: false },
          { action: 'monitor', label: '密切监控该客户经营状况', impact: '提前预警', requires_ceo_approval: false },
        ],
        notify_ceo: true,
        auto_execute: false,
      })
    }
  }

  return decisions
}

// --- 生成CEO通知摘要 ---
export function generateCEOAlert(decisions: BreakerDecision[]): string {
  if (decisions.length === 0) return ''

  const critical = decisions.filter(d => d.severity === 'critical')
  const warnings = decisions.filter(d => d.severity === 'warning')

  let alert = `# 🚨 财务风控Agent报告\n\n`
  alert += `**${critical.length}项严重风险 + ${warnings.length}项预警**\n\n`

  for (const d of decisions) {
    alert += `## ${d.title}\n`
    alert += `${d.description}\n\n`
    alert += `**建议操作：**\n`
    for (const a of d.recommended_actions) {
      alert += `- ${a.label}${a.requires_ceo_approval ? ' ⚡需您批准' : ''} — ${a.impact}\n`
    }
    alert += '\n---\n\n'
  }

  return alert
}

// --- 生成Agent动作记录 ---
export function generateBreakerActions(decisions: BreakerDecision[]): Partial<FinancialAgentAction>[] {
  return decisions.map(d => ({
    action_type: d.trigger === 'overdue_60_days' || d.trigger === 'overdue_exceed_credit'
      ? 'recommend_hold_shipment' as const
      : d.trigger === 'bad_debt_high'
      ? 'recommend_reduce_credit' as const
      : 'escalate_to_boss' as const,
    target_type: 'customer',
    target_id: d.customer_name,
    summary: d.title,
    detail: {
      trigger: d.trigger,
      severity: d.severity,
      recommended_actions: d.recommended_actions,
    } as Record<string, unknown>,
    execution_result: 'pending_approval' as const,
  }))
}
