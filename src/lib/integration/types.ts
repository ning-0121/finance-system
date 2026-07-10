// ============================================================
// 订单节拍器 <-> 财务系统 集成类型定义
// ============================================================

// --- Webhook 事件类型 ---
export type WebhookEventType =
  | 'order.created'           // 新订单创建
  | 'order.updated'           // 订单信息更新
  | 'order.activated'         // 订单生效
  | 'order.completed'         // 订单完成
  | 'order.cancelled'         // 订单取消
  | 'order.deleted'           // 订单删除（→ 保守冲销:作废草稿预算+撤审批,已过账标待人工）
  | 'milestone.updated'       // 里程碑状态更新
  | 'price_approval.requested' // 价格审批请求
  | 'delay.requested'         // 延期审批请求
  | 'cancel.requested'        // 取消订单审批请求(财务批准后节拍器才取消,回传 approval_type:'cancel')
  | 'milestone.requested'     // 里程碑财务确认请求(财务确认加工费/核准出运/收款,回传 approval_type:'milestone')
  | 'file.uploaded'           // 文件上传同步
  | 'approval.callback'       // 审批结果回调（从财务系统到节拍器）
  | 'order.resync'            // 订单全量重推
  | 'supplier.upserted'       // 供应商主数据同步
  | 'purchase_order.placed'   // 采购单下单（V1.0 头；V1.1 带 lines 行数据）
  | 'purchase_order.approval_requested'  // 采购单≥¥5000 请求财务审批（前置卡单，批/驳回传节拍器）
  | 'purchase_order.approval_cancelled'  // 采购审批撤销（节拍器删单/取消单时，移出财务审批队列）
  | 'goods_receipt.recorded'  // 收货登记（按实收核销应付；节拍器三条收货入口回传）
  | 'quotation.frozen'        // 内部报价单冻结 → 财务预算自动到位（6桶+逐行+核算日期/版本）
  | 'order.budget_updated'    // 采购核料预算即时更新（业务在采购核料填/改预算 → 送绝对总额，填 draft 预算）
  | 'shipping_invoice.issued' // 出货发票金额 → 应收（出运完成累计 CI 金额；draft 更新 total_revenue，已确认只告警）
  | 'test.ping'               // 联调签名测试（不入业务账）

// --- Webhook 事件载荷 ---
export interface WebhookPayload {
  event: WebhookEventType
  timestamp: string
  source: 'order-metronome' | 'finance-system'
  request_id: string         // 幂等性ID，防重复处理
  data: Record<string, unknown>
  signature: string          // HMAC-SHA256 签名
}

// --- 报价单分解（Phase 3 Path A：节拍器侧 webhook 可选 payload）---
// 若 metronome 推过来，则财务侧 webhook 直接据此构建 _cost_breakdown，
// 不再依赖业务人员手工补充 / OCR 抽取
export interface SyncedQuotation {
  fabric_amount?: number       // 面料 CNY
  accessory_amount?: number    // 辅料 CNY
  processing_amount?: number   // 加工费 CNY
  forwarder_amount?: number    // 货代 CNY
  container_amount?: number    // 装柜 CNY
  logistics_amount?: number    // 物流 CNY
  exchange_rate?: number       // 锁汇率
  product_name?: string        // 品名（瑜伽裤等）
  extras?: { name: string; amount: number }[]
  _source?: string             // 'metronome_quotation'
  _quoted_at?: string          // ISO timestamp
}

// --- 从节拍器同步过来的订单摘要 ---
export interface SyncedOrder {
  id: string
  order_no: string           // QM-YYYYMMDD-XXX
  customer_name: string
  incoterm: 'FOB' | 'DDP' | 'RMB_EX_TAX' | 'RMB_INC_TAX'
  delivery_type: 'export' | 'domestic'
  order_type: 'sample' | 'bulk'
  lifecycle_status: string
  po_number: string | null
  currency: string | null
  unit_price: number | null
  total_amount: number | null
  quantity: number | null
  quantity_unit: string | null
  factory_name: string | null
  etd: string | null
  payment_terms: string | null
  style_no: string | null
  notes: string | null
  created_by: string
  created_at: string
  updated_at: string
  // Phase 3 Path A: 节拍器推过来的报价细分（可选，全空也合法）
  quotation?: SyncedQuotation | null
}

// --- 价格审批请求 ---
export interface PriceApprovalRequest {
  id: string                 // pre_order_price_approvals.id
  order_no: string
  customer_name: string
  po_number: string
  requested_by: string
  requester_name: string
  price_diffs: PriceDiff[]
  summary: string
  form_snapshot: Record<string, unknown>
  expires_at: string
  created_at: string
}

export interface PriceDiff {
  field: string
  label: string
  internal_value: number | string
  external_value: number | string
  diff_pct?: number
}

// --- 延期审批请求 ---
export interface DelayApprovalRequest {
  id: string                 // delay_requests.id
  order_id: string
  order_no: string
  milestone_name: string
  requested_by: string
  requester_name: string
  reason_type: string
  reason_detail: string
  reason_category: string
  proposed_new_date: string | null
  current_due_date: string | null
  requires_customer_approval: boolean
  created_at: string
}

// --- 审批决定（财务系统 -> 节拍器） ---
export interface ApprovalDecision {
  approval_id: string        // price/delay/cancel=审批ID；purchase=采购单 purchase_order_id
  approval_type: 'price' | 'delay' | 'cancel' | 'purchase'
  decision: 'approved' | 'rejected'
  decided_by: string         // 财务系统用户ID
  decider_name: string       // 财务系统用户名
  decision_note: string | null
  decided_at: string
  po_no?: string             // 采购审批回传：便于节拍器按单号定位
}

// --- 集成日志 ---
export interface IntegrationLog {
  id: string
  event_type: WebhookEventType
  direction: 'inbound' | 'outbound'
  request_id: string
  source: string
  status: 'success' | 'failed' | 'pending'
  payload_summary: string
  error_message: string | null
  created_at: string
}
