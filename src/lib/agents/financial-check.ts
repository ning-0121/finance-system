// ============================================================
// 财务检查节点 — 下单前/采购前/出货前自动判断
// 对接节拍器的财务审核节点
// ============================================================

import type { FinancialCheckResult, FinancialCheckOutput, CustomerFinancialProfile } from '@/lib/types/agent'

// --- 下单前财务预审 ---
export function preOrderFinancialCheck(params: {
  customer: Partial<CustomerFinancialProfile>
  orderAmount: number
  estimatedProfitRate: number
  currency: string
}): FinancialCheckOutput {
  const { customer, orderAmount, estimatedProfitRate } = params
  const checks: FinancialCheckOutput['checks'] = []

  // 1. 客户风险等级
  const riskLevel = customer.risk_level || 'B'
  checks.push({
    name: '客户风险等级',
    passed: riskLevel === 'A' || riskLevel === 'B',
    detail: `当前等级: ${riskLevel}${riskLevel === 'D' || riskLevel === 'E' ? ' — 高风险客户' : ''}`,
    severity: riskLevel === 'E' ? 'critical' : riskLevel === 'D' ? 'warning' : 'info',
  })

  // 2. 当前欠款
  const outstanding = customer.total_outstanding || 0
  const creditLimit = customer.credit_limit || 0
  const wouldExceed = creditLimit > 0 && (outstanding + orderAmount) > creditLimit
  checks.push({
    name: '信用额度检查',
    passed: !wouldExceed,
    detail: wouldExceed
      ? `欠款$${outstanding.toLocaleString()} + 新单$${orderAmount.toLocaleString()} 将超信用额度$${creditLimit.toLocaleString()}`
      : `剩余额度 $${Math.max(0, creditLimit - outstanding).toLocaleString()}`,
    severity: wouldExceed ? 'critical' : 'info',
  })

  // 3. 历史逾期率
  const overdueRate = customer.overdue_rate || 0
  checks.push({
    name: '历史逾期率',
    passed: overdueRate < 0.3,
    detail: `逾期率 ${(overdueRate * 100).toFixed(0)}%${overdueRate > 0.5 ? ' — 严重' : ''}`,
    severity: overdueRate > 0.5 ? 'critical' : overdueRate > 0.3 ? 'warning' : 'info',
  })

  // 4. 订单利润率
  checks.push({
    name: '预计利润率',
    passed: estimatedProfitRate >= 10,
    detail: `${estimatedProfitRate.toFixed(1)}%${estimatedProfitRate < 5 ? ' — 极低' : estimatedProfitRate < 10 ? ' — 偏低' : ''}`,
    severity: estimatedProfitRate < 5 ? 'critical' : estimatedProfitRate < 10 ? 'warning' : 'info',
  })

  // 5. 客户依赖度
  const dependency = customer.dependency_score || 0
  checks.push({
    name: '客户依赖度',
    passed: dependency < 40,
    detail: `依赖度 ${dependency.toFixed(0)}%${dependency > 50 ? ' — 单一客户依赖过高' : ''}`,
    severity: dependency > 50 ? 'warning' : 'info',
  })

  // 决策
  const result = determineResult(checks, riskLevel)
  const summary = generateSummary(result, checks)

  return { result, checks, summary }
}

// --- 出货前财务放行检查 ---
export function preShipmentFinancialCheck(params: {
  customer: Partial<CustomerFinancialProfile>
  orderAmount: number
  paidAmount: number
  requiredPaymentRatio: number  // 约定的付款比例，如0.3=30%
  hasOverdueOrders: boolean
}): FinancialCheckOutput {
  const { customer, orderAmount, paidAmount, requiredPaymentRatio, hasOverdueOrders } = params
  const checks: FinancialCheckOutput['checks'] = []
  const paidRatio = orderAmount > 0 ? paidAmount / orderAmount : 0

  // 1. 付款比例
  checks.push({
    name: '付款比例达标',
    passed: paidRatio >= requiredPaymentRatio,
    detail: `已付 ${(paidRatio * 100).toFixed(0)}%（要求 ${(requiredPaymentRatio * 100).toFixed(0)}%）`,
    severity: paidRatio < requiredPaymentRatio ? 'critical' : 'info',
  })

  // 2. 历史逾期订单
  checks.push({
    name: '无逾期未付订单',
    passed: !hasOverdueOrders,
    detail: hasOverdueOrders ? '该客户有逾期未付订单' : '无逾期',
    severity: hasOverdueOrders ? 'warning' : 'info',
  })

  // 3. 客户风险
  const riskLevel = customer.risk_level || 'B'
  checks.push({
    name: '客户风险等级',
    passed: riskLevel !== 'D' && riskLevel !== 'E',
    detail: `等级: ${riskLevel}`,
    severity: riskLevel === 'D' || riskLevel === 'E' ? 'critical' : 'info',
  })

  // 4. 信用额度
  const outstanding = customer.total_outstanding || 0
  const creditLimit = customer.credit_limit || 0
  const overLimit = creditLimit > 0 && outstanding > creditLimit
  checks.push({
    name: '信用额度',
    passed: !overLimit,
    detail: overLimit ? `欠款已超信用额度 $${(outstanding - creditLimit).toLocaleString()}` : '正常',
    severity: overLimit ? 'critical' : 'info',
  })

  const criticalFails = checks.filter(c => !c.passed && c.severity === 'critical').length
  let result: FinancialCheckResult
  if (criticalFails >= 2) result = 'recommend_reject'
  else if (criticalFails === 1) result = 'need_boss_approval'
  else if (checks.some(c => !c.passed)) result = 'need_finance_approval'
  else result = 'auto_pass'

  return { result, checks, summary: generateSummary(result, checks) }
}

function determineResult(checks: FinancialCheckOutput['checks'], riskLevel: string): FinancialCheckResult {
  const criticalFails = checks.filter(c => !c.passed && c.severity === 'critical').length
  const warningFails = checks.filter(c => !c.passed && c.severity === 'warning').length

  if (riskLevel === 'E') return 'require_prepayment'
  if (criticalFails >= 2) return 'recommend_reject'
  if (criticalFails === 1) return 'need_boss_approval'
  if (warningFails > 0) return 'need_finance_approval'
  return 'auto_pass'
}

function generateSummary(result: FinancialCheckResult, checks: FinancialCheckOutput['checks']): string {
  const failedChecks = checks.filter(c => !c.passed)
  const labels: Record<FinancialCheckResult, string> = {
    auto_pass: '✅ 自动通过 — 所有检查项正常',
    need_finance_approval: `⚠️ 需财务审批 — ${failedChecks.map(c => c.name).join('、')}未通过`,
    need_boss_approval: `🔴 需老板审批 — ${failedChecks.map(c => c.name).join('、')}存在严重风险`,
    require_prepayment: '🚫 必须预付款 — 客户风险等级为E',
    recommend_reject: `❌ 建议拒绝 — ${failedChecks.length}项严重风险`,
  }
  return labels[result]
}
