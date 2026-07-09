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
  // 收款/银行信息（外贸客户电汇用）
  account_name?: string | null
  account_no?: string | null
  bank_name?: string | null
  swift_code?: string | null
  bank_address?: string | null
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
  version: number
  status: BudgetOrderStatus
  created_by: string
  creator?: User
  approved_by: string | null
  approver?: User
  approved_at: string | null
  notes: string | null
  attachments: string[] | null
  /** 实际收款金额（订单币种）；若填写则优先于「订单已关闭」推断已收 */
  ar_received_amount?: number | null
  /** 实际收款时间 */
  ar_received_at?: string | null
  /** 实际收款银行/账户（钱打到了哪个银行） */
  ar_received_bank?: string | null
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
// tax_point(票点)=供应商开票费用：不计预算/决算/毛利/GL成本，留作出口退税核算；仍计应付与供应商对账
export type CostType = 'fabric' | 'accessory' | 'processing' | 'freight' | 'container' | 'logistics' | 'commission' | 'customs' | 'procurement' | 'other' | 'tax_point'

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

// ============================================================
// 订单全生命周期 — 子单据体系
// ============================================================

export type SubDocumentType =
  | 'raw_material' | 'auxiliary_material' | 'factory_processing'
  | 'logistics' | 'commission' | 'tax' | 'other'

export const SUB_DOC_LABELS: Record<SubDocumentType, string> = {
  raw_material: '原料预采购单', auxiliary_material: '辅料预采购单',
  factory_processing: '加工厂预账单', logistics: '物流预费用单',
  commission: '提成预算单', tax: '预算税费', other: '预算其他费用',
}

export type SubDocumentStatus = 'draft' | 'approved' | 'executing' | 'settled'

export interface SubDocument {
  id: string
  budget_order_id: string
  doc_type: SubDocumentType
  doc_no: string | null
  supplier_name: string | null
  items: SubDocItem[]
  estimated_total: number
  currency: string
  exchange_rate: number
  status: SubDocumentStatus
  actual_total: number | null
  variance: number | null
  settlement_note: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface SubDocItem {
  name: string
  specification: string | null
  qty: number
  unit: string
  unit_price: number
  amount: number
}

// 供应商主数据（信息库）：录入付款/费用时选择，自动带出银行信息
export interface Supplier {
  id: string
  name: string
  account_no: string | null
  account_name: string | null
  bank_name: string | null
  contact: string | null
  phone: string | null
  attachment_url: string | null
  notes: string | null
  created_by?: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}

// 回款流水（应收财务化）：一笔银行/客户回款
export interface ReceivablePayment {
  id: string
  customer_id: string | null
  customer_name: string | null
  budget_order_id: string | null
  amount_original: number
  currency: string
  exchange_rate: number
  amount_cny: number
  received_at: string | null
  bank_account: string | null
  payment_reference: string | null
  source_type: 'manual' | 'bank_receipt' | 'wecom_file' | 'ocr'
  source_document_id: string | null
  matched_status: 'unmatched' | 'partially_matched' | 'matched' | 'disputed'
  dispute_reason?: string | null
  attachment_url?: string | null   // 水单/银行回单照片（finance-attachments 存储路径）
  notes: string | null
  created_by?: string | null
  created_at: string
  updated_at?: string
  updated_by?: string | null
  voided_at?: string | null
  voided_by?: string | null
  void_reason?: string | null
}

// 回款匹配分配：一笔回款分配到某订单的金额（多对多；权威已收来源）
export interface ReceivablePaymentAllocation {
  id: string
  receipt_id: string
  budget_order_id: string
  amount_cny: number
  amount_original: number | null
  created_by?: string | null
  created_at: string
  voided_at?: string | null
  voided_by?: string | null
  void_reason?: string | null
}

// 供应商付款流水（对账单负数行的来源；只挂供应商不挂订单）
export interface SupplierPayment {
  id: string
  supplier_name: string
  amount: number
  currency: string
  paid_at: string | null
  note: string | null
  created_by?: string | null
  created_at: string
  deleted_at?: string | null
}

export type InvoiceType = 'purchase_order' | 'supplier_invoice' | 'factory_contract' | 'factory_statement' | 'freight_bill' | 'commission_bill' | 'customer_statement' | 'tax_invoice' | 'other_invoice'
export type InvoiceStatus = 'pending' | 'approved' | 'paid' | 'disputed'

export interface ActualInvoice {
  id: string
  budget_order_id: string
  sub_document_id: string | null
  invoice_type: InvoiceType
  invoice_no: string
  supplier_name: string | null
  items: SubDocItem[]
  total_amount: number
  currency: string
  exchange_rate: number
  invoice_date: string | null
  due_date: string | null
  over_budget: boolean
  over_budget_reason: string | null
  over_budget_approved_by: string | null
  status: InvoiceStatus
  attachment_url: string | null
  created_by: string
  created_at: string
}

export type ShippingDocType = 'pi' | 'ci' | 'packing_list' | 'customs_declaration' | 'tax_refund'
export const SHIPPING_DOC_LABELS: Record<ShippingDocType, string> = {
  pi: '形式发票(PI)', ci: '商业发票(CI)', packing_list: '装箱单',
  customs_declaration: '报关单', tax_refund: '退税单',
}

export interface ShippingDocument {
  id: string
  budget_order_id: string
  doc_type: ShippingDocType
  document_no: string
  items: SubDocItem[]
  total_amount: number
  currency: string
  status: 'draft' | 'submitted' | 'completed'
  attachment_url: string | null
  created_at: string
}

export type ReturnType = 'raw_material' | 'auxiliary' | 'finished_good' | 'defective'
export type AccountingTreatment = 'add_to_cost' | 'reduce_cost' | 'scrap'

export interface InventoryReturn {
  id: string
  budget_order_id: string
  sub_document_id: string | null
  return_type: ReturnType
  items: SubDocItem[]
  total_value: number
  warehouse_location: string | null
  accounting_treatment: AccountingTreatment
  processed_by: string | null
  processed_at: string | null
  created_at: string
}

export interface OrderSettlement {
  id: string
  budget_order_id: string
  sub_settlements: SubSettlement[]
  order_level_costs: OrderLevelCost[]
  total_budget: number
  total_actual: number
  total_variance: number
  inventory_credit: number
  final_profit: number
  final_margin: number
  status: 'draft' | 'confirmed' | 'locked'
  settled_by: string | null
  settled_at: string | null
  created_at: string
}

export interface SubSettlement {
  sub_document_id: string
  doc_type: SubDocumentType
  supplier_name: string | null
  budgeted: number
  actual: number
  variance: number
  variance_pct: number
}

export interface OrderLevelCost {
  category: string
  budgeted: number
  actual: number
  variance: number
}

// 应付记录（从决算中自动剥离）
export type PaymentStatus = 'unpaid' | 'pending_approval' | 'approved' | 'paid' | 'cancelled'

export interface PayableRecord {
  id: string
  budget_order_id: string | null
  settlement_id: string | null
  invoice_id: string | null
  order_no: string | null
  supplier_name: string
  description: string
  cost_category: string | null
  bill_no: string | null      // 单据号：货代账单号/报关单号/发票号（防重复付款唯一键）
  payment_channel: 'company' | 'personal' | 'alipay' | 'wechat' | null  // 付款方式：公账/私账/支付宝/微信
  payee_name: string | null      // 收款人名称（默认取供应商户名，可改）
  payee_account: string | null   // 收款银行账号
  payee_bank: string | null      // 开户行
  amount: number
  currency: string
  budget_amount: number | null
  over_budget: boolean
  due_date: string | null
  payment_status: PaymentStatus
  approved_by: string | null
  approved_at: string | null
  paid_at: string | null
  paid_amount: number | null
  payment_method: string | null
  payment_reference: string | null
  notes: string | null
  attachment_url: string | null
  created_at: string
  updated_at: string
  deleted_at?: string | null
}
