// ============================================================
// 利润异常 Agent — 自动识别低利润/亏损/成本异常订单
// ============================================================

import type { FinancialRiskEvent } from '@/lib/types/agent'

export interface ProfitAnomaly {
  order_no: string
  customer: string
  margin: number
  issue: string
  severity: 'critical' | 'warning' | 'info'
  suggestions: string[]
}

export function detectProfitAnomalies(orders: {
  order_no: string
  customer: string
  total_revenue: number
  total_cost: number
  estimated_margin: number
  estimated_freight: number
  estimated_commission: number
  target_purchase_price: number
  currency: string
}[], historicalAvgMargin = 18): ProfitAnomaly[] {
  const anomalies: ProfitAnomaly[] = []

  for (const o of orders) {
    // 1. 亏损订单
    if (o.estimated_margin < 0) {
      anomalies.push({
        order_no: o.order_no, customer: o.customer, margin: o.estimated_margin,
        issue: '订单预计亏损',
        severity: 'critical',
        suggestions: ['立即复核成本构成', '评估是否可以涨价', '考虑取消或重新谈判'],
      })
      continue
    }

    // 2. 利润率低于10%
    if (o.estimated_margin < 10) {
      anomalies.push({
        order_no: o.order_no, customer: o.customer, margin: o.estimated_margin,
        issue: `毛利率${o.estimated_margin}%，低于10%底线`,
        severity: 'warning',
        suggestions: ['下次报价提高5-10%', '评估是否更换工厂', '考虑改FOB条款'],
      })
    }

    // 3. 远低于历史平均
    if (o.estimated_margin > 0 && o.estimated_margin < historicalAvgMargin * 0.6) {
      anomalies.push({
        order_no: o.order_no, customer: o.customer, margin: o.estimated_margin,
        issue: `毛利率${o.estimated_margin}%，远低于历史均值${historicalAvgMargin}%`,
        severity: 'warning',
        suggestions: ['分析该客户/品类是否长期低利润', '评估客户价值是否值得维持'],
      })
    }

    // 4. 运费占比异常（>15%收入）
    const freightRatio = o.total_revenue > 0 ? (o.estimated_freight / o.total_revenue) * 100 : 0
    if (freightRatio > 15) {
      anomalies.push({
        order_no: o.order_no, customer: o.customer, margin: o.estimated_margin,
        issue: `运费占比${freightRatio.toFixed(1)}%，异常偏高`,
        severity: 'warning',
        suggestions: ['与货代重新议价', '考虑拼柜降低运费', '建议客户承担部分运费'],
      })
    }

    // 5. 佣金占比异常（>8%收入）
    const commissionRatio = o.total_revenue > 0 ? (o.estimated_commission / o.total_revenue) * 100 : 0
    if (commissionRatio > 8) {
      anomalies.push({
        order_no: o.order_no, customer: o.customer, margin: o.estimated_margin,
        issue: `佣金占比${commissionRatio.toFixed(1)}%，建议优化渠道`,
        severity: 'info',
        suggestions: ['评估中间商价值', '考虑直客开发', '谈判降低佣金比例'],
      })
    }
  }

  return anomalies.sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 }
    return severityOrder[a.severity] - severityOrder[b.severity]
  })
}

// 生成风险事件
export function generateProfitRiskEvents(anomalies: ProfitAnomaly[]): Partial<FinancialRiskEvent>[] {
  return anomalies
    .filter(a => a.severity !== 'info')
    .map(a => ({
      risk_type: 'low_profit_order' as const,
      risk_level: a.severity === 'critical' ? 'red' as const : 'yellow' as const,
      title: `${a.order_no} ${a.issue}`,
      description: `客户: ${a.customer}, 毛利率: ${a.margin}%\n建议: ${a.suggestions.join('; ')}`,
      suggested_action: a.suggestions[0],
      owner_role: 'finance_manager',
      status: 'pending' as const,
    }))
}
