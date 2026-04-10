// ============================================================
// 回款 Agent — 催款优先级 + 自动风险评估 + 信用调整建议
// ============================================================

import type { CollectionPriority, FinancialRiskEvent } from '@/lib/types/agent'

export interface CollectionItem {
  customer_name: string
  order_no: string
  invoice_amount: number
  paid_amount: number
  balance: number
  currency: string
  due_date: string
  overdue_days: number
  priority: CollectionPriority
  suggested_actions: string[]
}

// 扫描所有未回款订单，生成催款列表
export function generateCollectionList(receivables: {
  customer: string
  orderNo: string
  amount: number
  paid: number
  balance: number
  currency: string
  dueDate: string
}[]): CollectionItem[] {
  const now = new Date()

  return receivables
    .filter(r => r.balance > 0)
    .map(r => {
      const due = new Date(r.dueDate)
      const overdueDays = Math.max(0, Math.floor((now.getTime() - due.getTime()) / 86400000))
      const priority = getCollectionPriority(overdueDays)
      const suggested_actions = getSuggestedActions(overdueDays, r.balance)

      return {
        customer_name: r.customer,
        order_no: r.orderNo,
        invoice_amount: r.amount,
        paid_amount: r.paid,
        balance: r.balance,
        currency: r.currency,
        due_date: r.dueDate,
        overdue_days: overdueDays,
        priority,
        suggested_actions,
      }
    })
    .sort((a, b) => {
      const priorityOrder = { P1: 0, P2: 1, P3: 2, P4: 3 }
      return priorityOrder[a.priority] - priorityOrder[b.priority] || b.balance - a.balance
    })
}

function getCollectionPriority(overdueDays: number): CollectionPriority {
  if (overdueDays > 60) return 'P1'
  if (overdueDays > 30) return 'P2'
  if (overdueDays > 0 || overdueDays >= -7) return 'P3'
  return 'P4'
}

function getSuggestedActions(overdueDays: number, balance: number): string[] {
  const actions: string[] = []

  if (overdueDays > 60) {
    actions.push('立即发送正式催款函')
    actions.push('暂停该客户新订单出货')
    if (balance > 50000) actions.push('降低信用额度至当前50%')
    actions.push('升级给老板处理')
  } else if (overdueDays > 30) {
    actions.push('发送催款邮件（第二次提醒）')
    actions.push('电话跟进催款')
    if (balance > 30000) actions.push('考虑暂停出货')
  } else if (overdueDays > 0) {
    actions.push('发送友好催款提醒')
  } else {
    actions.push('到期前7天提醒跟进')
  }

  return actions
}

// 检测客户是否需要降级
export function evaluateCustomerRisk(profile: {
  avg_payment_days: number
  overdue_rate: number
  total_outstanding: number
  credit_limit: number
}): { newRiskLevel: string; reasons: string[] } {
  const reasons: string[] = []
  let score = 0

  if (profile.avg_payment_days > 60) { score += 3; reasons.push(`平均付款天数${profile.avg_payment_days}天，严重超期`) }
  else if (profile.avg_payment_days > 45) { score += 2; reasons.push(`平均付款天数${profile.avg_payment_days}天`) }

  if (profile.overdue_rate > 0.5) { score += 3; reasons.push(`逾期率${(profile.overdue_rate * 100).toFixed(0)}%，超过50%`) }
  else if (profile.overdue_rate > 0.3) { score += 2; reasons.push(`逾期率${(profile.overdue_rate * 100).toFixed(0)}%`) }

  if (profile.credit_limit > 0 && profile.total_outstanding > profile.credit_limit) {
    score += 2; reasons.push(`欠款$${profile.total_outstanding.toLocaleString()}已超信用额度$${profile.credit_limit.toLocaleString()}`)
  }

  if (score >= 6) return { newRiskLevel: 'E', reasons }
  if (score >= 4) return { newRiskLevel: 'D', reasons }
  if (score >= 2) return { newRiskLevel: 'C', reasons }
  if (score >= 1) return { newRiskLevel: 'B', reasons }
  return { newRiskLevel: 'A', reasons: ['付款记录良好'] }
}

// 生成风险事件
export function generateOverdueRiskEvents(collections: CollectionItem[]): Partial<FinancialRiskEvent>[] {
  return collections
    .filter(c => c.priority === 'P1' || c.priority === 'P2')
    .map(c => ({
      risk_type: 'overdue_payment' as const,
      risk_level: c.priority === 'P1' ? 'red' as const : 'yellow' as const,
      title: `${c.customer_name} 逾期${c.overdue_days}天`,
      description: `订单 ${c.order_no} 余额 ${c.currency} ${c.balance.toLocaleString()}，逾期${c.overdue_days}天`,
      suggested_action: c.suggested_actions[0],
      owner_role: 'finance_manager',
      status: 'pending' as const,
    }))
}
