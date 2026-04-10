// ============================================================
// 外贸财务系统 - 核心类型定义
// ============================================================

// 用户角色
export type UserRole = 'admin' | 'finance_manager' | 'finance_staff' | 'sales' | 'procurement' | 'cashier'

// 用户
export interface User {
  id: string
  email: string
  name: string
  role: UserRole
  department: string | null
  avatar_url: string | null
  created_at: string
}

// 客户
export interface Customer {
  id: string
  name: string
  company: string
  contact: string | null
  email: string | null
  phone: string | null
  country: string | null
  currency: string
  credit_limit: number | null
  notes: string | null
  created_at: string
}

// 产品
export interface Product {
  id: string
  sku: string
  name: string
  category: string | null
  unit: string
  default_price: number | null
  specifications: string | null
  notes: string | null
  created_at: string
}

// 订单项
export interface OrderItem {
  product_id: string
  product_name: string
  sku: string
  qty: number
  unit: string
  unit_price: number
  amount: number
}

// 预算单状态
export type BudgetOrderStatus = 'draft' | 'pending_review' | 'approved' | 'rejected' | 'closed'

// 预算单
export interface BudgetOrder {
  id: string
  order_no: string
  customer_id: string
  customer?: Customer
  order_date: string
  delivery_date: string | null
  items: OrderItem[]
  target_purchase_price: number
  estimated_freight: number
  estimated_commission: number
  estimated_customs_fee: number
  other_costs: number
  total_revenue: number
  total_cost: number
  estimated_profit: number
  estimated_margin: number
  currency: string
  exchange_rate: number
  status: BudgetOrderStatus
  created_by: string
  creator?: User
  approved_by: string | null
  approver?: User
  approved_at: string | null
  notes: string | null
  attachments: string[] | null
  created_at: string
  updated_at: string
}

// 结算单状态
export type SettlementOrderStatus = 'draft' | 'confirmed' | 'locked'

// 结算单
export interface SettlementOrder {
  id: string
  order_no: string
  budget_order_id: string
  budget_order?: BudgetOrder
  actual_purchase_cost: number
  actual_freight: number
  actual_commission: number
  actual_customs_fee: number
  other_actual_costs: number
  total_actual_cost: number
  actual_revenue: number
  actual_profit: number
  actual_margin: number
  variance_amount: number
  variance_percentage: number
  variance_analysis: VarianceItem[] | null
  status: SettlementOrderStatus
  settled_by: string | null
  settled_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

// 差异项
export interface VarianceItem {
  category: string
  budgeted: number
  actual: number
  variance: number
  percentage: number
  explanation?: string
}

// 费用类型
export type CostType = 'freight' | 'commission' | 'customs' | 'procurement' | 'other'

// 费用项
export interface CostItem {
  id: string
  budget_order_id: string | null
  settlement_order_id: string | null
  cost_type: CostType
  description: string
  amount: number
  currency: string
  exchange_rate: number
  source_module: string | null
  source_id: string | null
  created_at: string
  created_by: string
}

// 审批动作
export type ApprovalAction = 'submit' | 'approve' | 'reject' | 'revoke'

// 审批记录
export interface ApprovalLog {
  id: string
  entity_type: string
  entity_id: string
  action: ApprovalAction
  from_status: string
  to_status: string
  operator_id: string
  operator?: User
  comment: string | null
  created_at: string
}

// 导航菜单项
export interface NavItem {
  title: string
  href: string
  icon: string
  badge?: number
  children?: NavItem[]
}

// 统计卡片
export interface StatCard {
  title: string
  value: string | number
  change?: number
  changeLabel?: string
  icon?: string
}

// AI 聊天消息
export interface AIChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  data?: Record<string, unknown>
}

// 利润汇总
export interface ProfitSummary {
  total_revenue: number
  total_cost: number
  total_profit: number
  avg_margin: number
  order_count: number
  period: string
}

// 预警
export interface Alert {
  id: string
  type: 'margin_low' | 'cost_overrun' | 'payment_overdue' | 'variance_high'
  severity: 'info' | 'warning' | 'critical'
  title: string
  message: string
  entity_type: string
  entity_id: string
  is_read: boolean
  created_at: string
}
