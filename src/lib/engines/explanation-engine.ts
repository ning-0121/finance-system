// 财务解释引擎 — 规则模板驱动，自动生成中文解释
// 不依赖AI，纯规则匹配，确保可审计、可解释

export interface Explanation {
  text: string
  severity: 'info' | 'warning' | 'critical'
  category: string
  actionHref?: string
}

export interface OverviewData {
  // 风险
  criticalFindings: number
  warningFindings: number
  activeFreezes: number
  lowTrustCount: number
  highRiskOrders: number
  highRiskCustomers: number

  // 待处理
  pendingApprovals: number
  pendingPayments: number
  blockedActions: number
  openRiskEvents: number
  closingPending: number
  closingTotal: number

  // 健康
  glBalanced: boolean
  trustAvg: number
  rollbackCount: number
  rejectCount: number

  // 趋势
  profitTrend: number // 正=增长 负=下降，百分比
  trustDowngrades: number
  recentFreezes: number

  // 额外上下文
  topRiskCustomer?: string
  topRiskOrder?: string
  topRiskSupplier?: string
  cashflowGap?: number
}

/**
 * 基于数据生成中文解释
 * 规则优先级：critical > warning > info
 */
export function generateExplanations(data: OverviewData): Explanation[] {
  const explanations: Explanation[] = []

  // === CRITICAL ===

  if (data.criticalFindings > 0) {
    explanations.push({
      text: `当前有 ${data.criticalFindings} 个严重财务异常待处理，请立即查看。`,
      severity: 'critical',
      category: '稽核',
      actionHref: '/control-center/audit',
    })
  }

  if (data.highRiskOrders > 3) {
    explanations.push({
      text: `${data.highRiskOrders} 个订单利润异常（亏损或毛利率<10%），需要重点关注。`,
      severity: 'critical',
      category: '利润',
      actionHref: '/orders',
    })
  }

  if (!data.glBalanced) {
    explanations.push({
      text: '总账借贷不平衡！请立即检查凭证。',
      severity: 'critical',
      category: '总账',
      actionHref: '/gl/trial-balance',
    })
  }

  if (data.cashflowGap && data.cashflowGap < -50000) {
    explanations.push({
      text: `现金流预计缺口 ¥${Math.abs(data.cashflowGap).toLocaleString()}，建议加速催收或延迟付款。`,
      severity: 'critical',
      category: '现金流',
      actionHref: '/cashflow',
    })
  }

  // === WARNING ===

  if (data.activeFreezes > 0) {
    explanations.push({
      text: `当前有 ${data.activeFreezes} 个实体被冻结，相关业务操作暂停中。`,
      severity: 'warning',
      category: '冻结',
      actionHref: '/control-center/freeze',
    })
  }

  if (data.trustDowngrades > 0) {
    explanations.push({
      text: `最近7天有 ${data.trustDowngrades} 个对象信任等级下降，建议关注。`,
      severity: 'warning',
      category: '信任',
      actionHref: '/control-center/trust',
    })
  }

  if (data.pendingApprovals > 5) {
    explanations.push({
      text: `${data.pendingApprovals} 笔待审批事项积压，请及时处理。`,
      severity: 'warning',
      category: '审批',
      actionHref: '/approvals',
    })
  }

  if (data.closingPending > 3 && data.closingTotal > 0) {
    explanations.push({
      text: `本月月结还有 ${data.closingPending}/${data.closingTotal} 项检查未完成。`,
      severity: 'warning',
      category: '月结',
      actionHref: '/control-center/closing',
    })
  }

  if (data.blockedActions > 0) {
    explanations.push({
      text: `${data.blockedActions} 个自动执行动作被阻塞，可能影响业务流程。`,
      severity: 'warning',
      category: '执行',
      actionHref: '/documents',
    })
  }

  if (data.profitTrend < -10) {
    explanations.push({
      text: `利润环比下降 ${Math.abs(data.profitTrend).toFixed(1)}%${data.topRiskCustomer ? `，主要来自客户「${data.topRiskCustomer}」` : ''}。`,
      severity: 'warning',
      category: '利润',
      actionHref: '/analytics',
    })
  }

  if (data.topRiskSupplier) {
    explanations.push({
      text: `供应商「${data.topRiskSupplier}」近期风险上升，建议评估替代方案。`,
      severity: 'warning',
      category: '供应商',
      actionHref: '/profiles/suppliers',
    })
  }

  // === INFO ===

  if (data.openRiskEvents > 0) {
    explanations.push({
      text: `${data.openRiskEvents} 个风险事件待处理。`,
      severity: 'info',
      category: '风险',
      actionHref: '/risks',
    })
  }

  if (data.lowTrustCount > 0) {
    explanations.push({
      text: `${data.lowTrustCount} 个对象信任等级较低（T0-T1），自动执行已受限。`,
      severity: 'info',
      category: '信任',
      actionHref: '/control-center/trust',
    })
  }

  if (data.rollbackCount > 2) {
    explanations.push({
      text: `近期发生 ${data.rollbackCount} 次回滚操作，建议检查相关模板/动作配置。`,
      severity: 'info',
      category: '回滚',
      actionHref: '/control-center/timeline',
    })
  }

  if (explanations.length === 0) {
    explanations.push({
      text: '系统运行正常，无需紧急处理。',
      severity: 'info',
      category: '系统',
    })
  }

  // 按严重性排序
  const order = { critical: 0, warning: 1, info: 2 }
  return explanations.sort((a, b) => order[a.severity] - order[b.severity])
}
