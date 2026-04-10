// ============================================================
// 付款 Agent — 付款优先级 + 现金流保护 + 供应商风险
// ============================================================

import type { PaymentPriority } from '@/lib/types/agent'

export interface PaymentItem {
  supplier_name: string
  invoice_no: string
  amount: number
  currency: string
  due_date: string
  days_until_due: number
  priority: PaymentPriority
  reason: string
  impact_if_not_paid: string
}

export function generatePaymentPlan(payables: {
  supplier: string
  invoiceNo: string
  amount: number
  currency: string
  dueDate: string
  supplierRiskLevel?: string
  affectsProduction?: boolean
  historicalStopSupply?: number
}[]): PaymentItem[] {
  const now = new Date()

  return payables
    .map(p => {
      const due = new Date(p.dueDate)
      const daysUntilDue = Math.floor((due.getTime() - now.getTime()) / 86400000)
      const priority = getPaymentPriority(daysUntilDue, p)
      const { reason, impact } = getPaymentContext(daysUntilDue, p)

      return {
        supplier_name: p.supplier,
        invoice_no: p.invoiceNo,
        amount: p.amount,
        currency: p.currency,
        due_date: p.dueDate,
        days_until_due: daysUntilDue,
        priority,
        reason,
        impact_if_not_paid: impact,
      }
    })
    .sort((a, b) => {
      const priorityOrder = { S1: 0, S2: 1, S3: 2, S4: 3 }
      return priorityOrder[a.priority] - priorityOrder[b.priority] || a.days_until_due - b.days_until_due
    })
}

function getPaymentPriority(daysUntilDue: number, p: {
  affectsProduction?: boolean
  historicalStopSupply?: number
  supplierRiskLevel?: string
}): PaymentPriority {
  // 已逾期且影响生产
  if (daysUntilDue < 0 && p.affectsProduction) return 'S1'
  // 供应商有断供历史
  if ((p.historicalStopSupply || 0) > 0 && daysUntilDue < 7) return 'S1'
  // 7天内到期的重要供应商
  if (daysUntilDue <= 7 && p.supplierRiskLevel !== 'A') return 'S2'
  // 30天内到期
  if (daysUntilDue <= 30) return 'S3'
  // 其他
  return 'S4'
}

function getPaymentContext(daysUntilDue: number, p: {
  supplier: string
  affectsProduction?: boolean
  historicalStopSupply?: number
}): { reason: string; impact: string } {
  if (daysUntilDue < 0 && p.affectsProduction) {
    return {
      reason: `已逾期${Math.abs(daysUntilDue)}天，影响在产订单`,
      impact: `${p.supplier}可能停止供料，导致交期延误`,
    }
  }
  if ((p.historicalStopSupply || 0) > 0) {
    return {
      reason: `该供应商有${p.historicalStopSupply}次断供记录`,
      impact: '高断供风险，延迟付款可能导致停工',
    }
  }
  if (daysUntilDue <= 7) {
    return {
      reason: `${daysUntilDue}天后到期`,
      impact: '按期付款维护供应商关系',
    }
  }
  if (daysUntilDue <= 30) {
    return {
      reason: `${daysUntilDue}天后到期，可适当延迟`,
      impact: '延迟付款不影响当前生产',
    }
  }
  return {
    reason: `${daysUntilDue}天后到期`,
    impact: '可谈判延期付款',
  }
}

// 本周付款汇总
export function getWeeklyPaymentSummary(items: PaymentItem[]) {
  const mustPay = items.filter(i => i.priority === 'S1')
  const shouldPay = items.filter(i => i.priority === 'S2')
  const canDelay = items.filter(i => i.priority === 'S3' || i.priority === 'S4')

  return {
    must_pay_total: mustPay.reduce((s, i) => s + i.amount, 0),
    must_pay_count: mustPay.length,
    should_pay_total: shouldPay.reduce((s, i) => s + i.amount, 0),
    should_pay_count: shouldPay.length,
    can_delay_total: canDelay.reduce((s, i) => s + i.amount, 0),
    can_delay_count: canDelay.length,
    items: { mustPay, shouldPay, canDelay },
  }
}
