// ============================================================
// 财务Agent层 — 类型定义
// ============================================================

// --- 客户财务画像 ---
export type CustomerRiskLevel = 'A' | 'B' | 'C' | 'D' | 'E'
export const CUSTOMER_RISK_LABELS: Record<CustomerRiskLevel, string> = {
  A: '稳定优质', B: '正常', C: '有风险', D: '高风险', E: '必须预付',
}
export const CUSTOMER_RISK_COLORS: Record<CustomerRiskLevel, string> = {
  A: 'bg-green-100 text-green-700', B: 'bg-blue-100 text-blue-700',
  C: 'bg-amber-100 text-amber-700', D: 'bg-red-100 text-red-700',
  E: 'bg-red-200 text-red-800',
}

export interface CustomerFinancialProfile {
  id: string
  customer_id: string | null
  customer_name: string
  avg_payment_days: number
  overdue_rate: number
  average_order_profit_rate: number
  deduction_frequency: number
  late_confirmation_frequency: number
  invoice_dispute_frequency: number
  bad_debt_score: number
  dependency_score: number
  total_outstanding: number
  credit_limit: number
  risk_level: CustomerRiskLevel
  last_updated_at: string
}

// --- 供应商财务画像 ---
export interface SupplierFinancialProfile {
  id: string
  supplier_name: string
  avg_payment_term_days: number
  avg_delay_tolerance_days: number
  historical_stop_supply_count: number
  urgency_score: number
  dependency_score: number
  risk_level: CustomerRiskLevel
  preferred_payment_method: string
  current_outstanding: number
  next_due_amount: number
  next_due_date: string | null
}

// --- 现金流预测 ---
export type CashflowWarningLevel = 'safe' | 'attention' | 'danger' | 'critical'
export type CashflowScenario = 'normal' | 'conservative' | 'extreme'

export const CASHFLOW_WARNING_COLORS: Record<CashflowWarningLevel, string> = {
  safe: 'bg-green-100 text-green-700', attention: 'bg-amber-100 text-amber-700',
  danger: 'bg-red-100 text-red-700', critical: 'bg-red-200 text-red-800',
}

export interface CashflowForecast {
  id: string
  forecast_date: string
  expected_inflow: number
  expected_outflow: number
  expected_cash_balance: number
  warning_level: CashflowWarningLevel
  top_risk_reason: string | null
  suggested_action: string | null
  scenario: CashflowScenario
}

// --- 风险事件 ---
export type RiskType =
  | 'overdue_payment' | 'low_profit_order' | 'abnormal_material_cost'
  | 'supplier_delay' | 'insufficient_cashflow' | 'customer_high_dependency'
  | 'exchange_rate_risk' | 'tax_risk' | 'duplicate_payment' | 'invoice_mismatch'

export const RISK_TYPE_LABELS: Record<RiskType, string> = {
  overdue_payment: '客户逾期付款', low_profit_order: '低利润订单',
  abnormal_material_cost: '原料成本异常', supplier_delay: '供应商延期',
  insufficient_cashflow: '现金流不足', customer_high_dependency: '客户依赖过高',
  exchange_rate_risk: '汇率风险', tax_risk: '税务风险',
  duplicate_payment: '重复付款', invoice_mismatch: '发票不一致',
}

export type RiskLevel = 'red' | 'yellow' | 'green'
export type RiskStatus = 'pending' | 'processing' | 'resolved' | 'ignored'

export interface FinancialRiskEvent {
  id: string
  risk_type: RiskType
  risk_level: RiskLevel
  related_order_id: string | null
  related_customer_id: string | null
  related_supplier_name: string | null
  title: string
  description: string
  suggested_action: string | null
  owner_role: string
  status: RiskStatus
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

// --- Agent动作 ---
export type AgentActionType =
  | 'send_collection_reminder' | 'generate_payment_plan' | 'create_cashflow_alert'
  | 'recommend_hold_shipment' | 'recommend_pause_order' | 'recommend_reduce_credit'
  | 'auto_match_payment' | 'auto_risk_detection' | 'generate_daily_report'
  | 'update_customer_profile' | 'update_supplier_profile' | 'escalate_to_boss'

export const AGENT_ACTION_LABELS: Record<AgentActionType, string> = {
  send_collection_reminder: '发送催款提醒', generate_payment_plan: '生成付款计划',
  create_cashflow_alert: '现金流预警', recommend_hold_shipment: '建议扣货',
  recommend_pause_order: '建议暂停订单', recommend_reduce_credit: '建议降低信用额度',
  auto_match_payment: '自动匹配付款', auto_risk_detection: '自动风险检测',
  generate_daily_report: '生成日报', update_customer_profile: '更新客户画像',
  update_supplier_profile: '更新供应商画像', escalate_to_boss: '升级给老板',
}

export interface FinancialAgentAction {
  id: string
  action_type: AgentActionType
  target_type: string | null
  target_id: string | null
  summary: string
  detail: Record<string, unknown>
  execution_result: 'success' | 'failed' | 'pending_approval' | 'skipped'
  approved_by: string | null
  approved_at: string | null
  created_at: string
}

// --- 催款优先级 ---
export type CollectionPriority = 'P1' | 'P2' | 'P3' | 'P4'
export const COLLECTION_PRIORITY_LABELS: Record<CollectionPriority, string> = {
  P1: '超过60天 · 紧急', P2: '超过30天 · 重要',
  P3: '7天内到期 · 关注', P4: '正常跟进',
}

// --- 付款优先级 ---
export type PaymentPriority = 'S1' | 'S2' | 'S3' | 'S4'
export const PAYMENT_PRIORITY_LABELS: Record<PaymentPriority, string> = {
  S1: '影响生产·必须付', S2: '重要供应商·建议付',
  S3: '可延迟', S4: '建议谈判延迟',
}

// --- 财务检查节点结果 ---
export type FinancialCheckResult = 'auto_pass' | 'need_finance_approval' | 'need_boss_approval' | 'require_prepayment' | 'recommend_reject'

export interface FinancialCheckOutput {
  result: FinancialCheckResult
  checks: {
    name: string
    passed: boolean
    detail: string
    severity: 'info' | 'warning' | 'critical'
  }[]
  summary: string
}
