// ============================================================
// Action Registry — 统一配置每种文件类型的自动执行动作
// 每种文件类型 → 动作列表 → 执行顺序 → 必需字段 → 通知规则
// ============================================================

import type { DocCategory, DocumentActionType } from '@/lib/types/document'
import type { SafetyLevel } from './safety'

export interface ActionConfig {
  action_type: DocumentActionType
  label: string
  safety_level: SafetyLevel          // L1低风险→L4极高风险
  execution_order: number
  depends_on: string[]               // 依赖的action_type列表
  dependency_type: 'hard' | 'soft'   // hard=前置失败则阻断 soft=可跳过
  required_fields: string[]          // 执行前必须有值的字段
  target_table: string               // 写入哪张业务表
  responsible_role: string           // 责任人角色
  notification: 'none' | 'finance' | 'ceo' | 'all'
  creates_todo: boolean
  creates_approval: boolean
  rollback_supported: boolean
}

// 完整 Action Registry — 每种文件类型的动作配置
export const ACTION_REGISTRY: Record<DocCategory, ActionConfig[]> = {
  customer_po: [
    { action_type: 'create_order', label: '创建订单草稿', safety_level: 'L2', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['customer_name', 'total_amount', 'currency'], target_table: 'budget_orders', responsible_role: 'finance_staff', notification: 'finance', creates_todo: true, creates_approval: false, rollback_supported: true },
    { action_type: 'create_budget', label: '创建预算草稿', safety_level: 'L2', execution_order: 2, depends_on: ['create_order'], dependency_type: 'hard', required_fields: ['total_amount'], target_table: 'budget_sub_documents', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
    { action_type: 'create_risk_check', label: '运行财务预审', safety_level: 'L1', execution_order: 3, depends_on: ['create_order'], dependency_type: 'soft', required_fields: ['customer_name'], target_table: 'financial_risk_events', responsible_role: 'finance_staff', notification: 'finance', creates_todo: true, creates_approval: false, rollback_supported: false },
  ],

  supplier_invoice: [
    { action_type: 'create_payment_request', label: '创建付款申请', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['supplier_name', 'total_amount', 'invoice_no'], target_table: 'actual_invoices', responsible_role: 'finance_manager', notification: 'finance', creates_todo: true, creates_approval: true, rollback_supported: true },
    { action_type: 'link_cost_item', label: '归集订单成本', safety_level: 'L2', execution_order: 2, depends_on: ['create_payment_request'], dependency_type: 'soft', required_fields: ['total_amount'], target_table: 'cost_items', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],

  bank_receipt: [
    { action_type: 'update_receivable', label: '登记回款', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['amount', 'currency'], target_table: 'actual_invoices', responsible_role: 'finance_staff', notification: 'finance', creates_todo: false, creates_approval: false, rollback_supported: true },
    { action_type: 'update_customer_credit', label: '更新客户信用', safety_level: 'L3', execution_order: 2, depends_on: ['update_receivable'], dependency_type: 'hard', required_fields: ['payer_name'], target_table: 'customer_financial_profiles', responsible_role: 'finance_manager', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
    { action_type: 'update_cashflow', label: '更新现金流', safety_level: 'L3', execution_order: 3, depends_on: ['update_receivable'], dependency_type: 'soft', required_fields: ['amount'], target_table: 'cashflow_forecasts', responsible_role: 'finance_manager', notification: 'ceo', creates_todo: false, creates_approval: false, rollback_supported: false },
  ],

  payment_screenshot: [
    { action_type: 'update_receivable', label: '登记回款', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['amount'], target_table: 'actual_invoices', responsible_role: 'finance_staff', notification: 'finance', creates_todo: false, creates_approval: false, rollback_supported: true },
    { action_type: 'update_customer_credit', label: '更新客户信用', safety_level: 'L3', execution_order: 2, depends_on: [], dependency_type: 'soft', required_fields: [], target_table: 'customer_financial_profiles', responsible_role: 'finance_manager', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],
  packing_list: [
    { action_type: 'update_shipping_status', label: '更新出货装箱', safety_level: 'L2', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: [], target_table: 'shipping_documents', responsible_role: 'finance_staff', notification: 'finance', creates_todo: false, creates_approval: false, rollback_supported: true },
    { action_type: 'create_risk_check', label: '出货前财务检查', safety_level: 'L3', execution_order: 2, depends_on: [], dependency_type: 'soft', required_fields: [], target_table: 'financial_risk_events', responsible_role: 'finance_manager', notification: 'ceo', creates_todo: true, creates_approval: true, rollback_supported: false },
  ],
  customs_declaration: [
    { action_type: 'update_shipping_status', label: '更新报关状态', safety_level: 'L2', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: [], target_table: 'shipping_documents', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
    { action_type: 'link_cost_item', label: '关联报关费', safety_level: 'L2', execution_order: 2, depends_on: [], dependency_type: 'soft', required_fields: ['total_amount'], target_table: 'cost_items', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],
  tax_refund: [
    { action_type: 'update_cashflow', label: '更新退税预测', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['total_amount'], target_table: 'cashflow_forecasts', responsible_role: 'finance_manager', notification: 'finance', creates_todo: true, creates_approval: false, rollback_supported: false },
  ],
  contract: [
    { action_type: 'create_order', label: '基于合同创建订单', safety_level: 'L2', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['total_amount'], target_table: 'budget_orders', responsible_role: 'finance_staff', notification: 'finance', creates_todo: true, creates_approval: false, rollback_supported: true },
  ],
  pi: [
    { action_type: 'update_shipping_status', label: '更新PI状态', safety_level: 'L2', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: [], target_table: 'shipping_documents', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],
  ci: [
    { action_type: 'update_shipping_status', label: '更新CI状态', safety_level: 'L2', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: [], target_table: 'shipping_documents', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],
  logistics_bill: [
    { action_type: 'link_cost_item', label: '关联运费', safety_level: 'L2', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['total_amount'], target_table: 'cost_items', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
    { action_type: 'create_payment_request', label: '创建运费付款', safety_level: 'L3', execution_order: 2, depends_on: [], dependency_type: 'soft', required_fields: ['total_amount', 'logistics_company'], target_table: 'actual_invoices', responsible_role: 'finance_manager', notification: 'finance', creates_todo: true, creates_approval: true, rollback_supported: true },
  ],
  purchase_order: [
    { action_type: 'create_payment_request', label: '创建付款申请', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['supplier_name', 'total_amount'], target_table: 'actual_invoices', responsible_role: 'finance_manager', notification: 'finance', creates_todo: true, creates_approval: true, rollback_supported: true },
    { action_type: 'link_cost_item', label: '归集采购成本', safety_level: 'L2', execution_order: 2, depends_on: [], dependency_type: 'soft', required_fields: ['total_amount'], target_table: 'cost_items', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],
  fabric_order: [
    { action_type: 'create_payment_request', label: '创建面料付款', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['supplier_name', 'total_amount'], target_table: 'actual_invoices', responsible_role: 'finance_manager', notification: 'finance', creates_todo: true, creates_approval: true, rollback_supported: true },
    { action_type: 'link_cost_item', label: '归集面料成本', safety_level: 'L2', execution_order: 2, depends_on: [], dependency_type: 'soft', required_fields: ['total_amount'], target_table: 'cost_items', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],
  accessory_order: [
    { action_type: 'create_payment_request', label: '创建辅料付款', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['supplier_name', 'total_amount'], target_table: 'actual_invoices', responsible_role: 'finance_manager', notification: 'finance', creates_todo: true, creates_approval: true, rollback_supported: true },
    { action_type: 'link_cost_item', label: '归集辅料成本', safety_level: 'L2', execution_order: 2, depends_on: [], dependency_type: 'soft', required_fields: ['total_amount'], target_table: 'cost_items', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],
  customer_statement: [
    { action_type: 'update_receivable', label: '核对客户对账', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['customer_name', 'total_amount'], target_table: 'actual_invoices', responsible_role: 'finance_staff', notification: 'finance', creates_todo: true, creates_approval: false, rollback_supported: false },
  ],
  supplier_statement: [
    { action_type: 'create_payment_request', label: '核对供应商对账', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['supplier_name', 'total_amount'], target_table: 'actual_invoices', responsible_role: 'finance_manager', notification: 'finance', creates_todo: true, creates_approval: false, rollback_supported: false },
  ],
  factory_delivery: [
    { action_type: 'link_cost_item', label: '关联加工费', safety_level: 'L2', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['total_amount'], target_table: 'cost_items', responsible_role: 'finance_staff', notification: 'none', creates_todo: false, creates_approval: false, rollback_supported: true },
  ],
  expense_claim: [
    { action_type: 'link_cost_item', label: '录入报销费用', safety_level: 'L3', execution_order: 1, depends_on: [], dependency_type: 'hard', required_fields: ['amount'], target_table: 'cost_items', responsible_role: 'finance_manager', notification: 'finance', creates_todo: false, creates_approval: true, rollback_supported: true },
  ],
}

// 获取某文件类型的动作配置
export function getActionsForCategory(category: DocCategory): ActionConfig[] {
  return (ACTION_REGISTRY[category] || []).sort((a, b) => a.execution_order - b.execution_order)
}

// 检查是否满足执行条件
export function canExecuteAction(config: ActionConfig, fields: Record<string, unknown>): { canExecute: boolean; missingFields: string[] } {
  const missing = config.required_fields.filter(f => {
    const v = fields[f]
    return v === null || v === undefined || v === ''
  })
  return { canExecute: missing.length === 0, missingFields: missing }
}
