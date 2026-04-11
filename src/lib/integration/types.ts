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
  | 'milestone.updated'       // 里程碑状态更新
  | 'price_approval.requested' // 价格审批请求
  | 'delay.requested'         // 延期审批请求
  | 'file.uploaded'           // 文件上传同步
  | 'approval.callback'       // 审批结果回调（从财务系统到节拍器）

// --- Webhook 事件载荷 ---
export interface WebhookPayload {
  event: WebhookEventType
  timestamp: string
  source: 'order-metronome' | 'finance-system'
  request_id: string         // 幂等性ID，防重复处理
  data: Record<string, unknown>
  signature: string          // HMAC-SHA256 签名
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
  approval_id: string
  approval_type: 'price' | 'delay' | 'cancel'
  decision: 'approved' | 'rejected'
  decided_by: string         // 财务系统用户ID
  decider_name: string       // 财务系统用户名
  decision_note: string | null
  decided_at: string
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
