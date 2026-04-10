// ============================================================
// Document Intelligence Engine — 类型定义
// ============================================================

// 18种文件类别
export type DocCategory =
  | 'customer_po'          // 客户PO
  | 'pi'                   // PI
  | 'ci'                   // CI
  | 'packing_list'         // 装箱单
  | 'customs_declaration'  // 报关单
  | 'tax_refund'           // 退税单
  | 'supplier_invoice'     // 供应商发票
  | 'purchase_order'       // 采购单
  | 'logistics_bill'       // 物流账单
  | 'bank_receipt'         // 银行回单
  | 'payment_screenshot'   // 付款截图
  | 'expense_claim'        // 费用报销单
  | 'contract'             // 合同
  | 'customer_statement'   // 客户对账单
  | 'supplier_statement'   // 供应商对账单
  | 'factory_delivery'     // 工厂送货单
  | 'fabric_order'         // 面料单
  | 'accessory_order'      // 辅料单

export const DOC_CATEGORY_LABELS: Record<DocCategory, string> = {
  customer_po: '客户PO', pi: 'PI(形式发票)', ci: 'CI(商业发票)',
  packing_list: '装箱单', customs_declaration: '报关单', tax_refund: '退税单',
  supplier_invoice: '供应商发票', purchase_order: '采购单', logistics_bill: '物流账单',
  bank_receipt: '银行回单', payment_screenshot: '付款截图', expense_claim: '费用报销单',
  contract: '合同', customer_statement: '客户对账单', supplier_statement: '供应商对账单',
  factory_delivery: '工厂送货单', fabric_order: '面料单', accessory_order: '辅料单',
}

export type DocStatus = 'pending' | 'extracting' | 'extracted' | 'confirmed' | 'rejected'
export type FileType = 'excel' | 'pdf' | 'image' | 'word'

// 字段提取模板 — 每种文件类别需要提取哪些字段
export const FIELD_TEMPLATES: Record<DocCategory, { field: string; label: string; required: boolean }[]> = {
  customer_po: [
    { field: 'customer_name', label: '客户名', required: true },
    { field: 'po_number', label: 'PO号', required: true },
    { field: 'order_date', label: '下单日期', required: false },
    { field: 'items', label: '产品明细', required: false },
    { field: 'total_amount', label: '总金额', required: true },
    { field: 'currency', label: '币种', required: true },
    { field: 'payment_terms', label: '付款条件', required: false },
    { field: 'delivery_date', label: '交货日期', required: false },
  ],
  supplier_invoice: [
    { field: 'supplier_name', label: '供应商', required: true },
    { field: 'invoice_no', label: '发票号', required: true },
    { field: 'items', label: '明细', required: false },
    { field: 'total_amount', label: '总金额', required: true },
    { field: 'currency', label: '币种', required: true },
    { field: 'tax_amount', label: '税额', required: false },
    { field: 'invoice_date', label: '日期', required: false },
    { field: 'due_date', label: '到期日', required: false },
  ],
  bank_receipt: [
    { field: 'payer_name', label: '付款人', required: true },
    { field: 'amount', label: '金额', required: true },
    { field: 'currency', label: '币种', required: true },
    { field: 'transaction_date', label: '交易日期', required: true },
    { field: 'bank_name', label: '银行', required: false },
    { field: 'reference_no', label: '参考号', required: false },
  ],
  packing_list: [
    { field: 'order_no', label: '订单号', required: false },
    { field: 'items', label: '装箱明细', required: false },
    { field: 'carton_count', label: '箱数', required: false },
    { field: 'gross_weight', label: '毛重', required: false },
    { field: 'net_weight', label: '净重', required: false },
    { field: 'cbm', label: '体积(CBM)', required: false },
  ],
  logistics_bill: [
    { field: 'logistics_company', label: '物流公司', required: true },
    { field: 'tracking_no', label: '物流单号', required: false },
    { field: 'amount', label: '运费金额', required: true },
    { field: 'currency', label: '币种', required: true },
    { field: 'ship_date', label: '船期', required: false },
    { field: 'etd', label: 'ETD', required: false },
    { field: 'eta', label: 'ETA', required: false },
  ],
  // 其他类别用通用模板
  pi: [{ field: 'customer_name', label: '客户', required: true }, { field: 'total_amount', label: '金额', required: true }, { field: 'currency', label: '币种', required: true }, { field: 'items', label: '明细', required: false }],
  ci: [{ field: 'customer_name', label: '客户', required: true }, { field: 'total_amount', label: '金额', required: true }, { field: 'currency', label: '币种', required: true }, { field: 'items', label: '明细', required: false }],
  customs_declaration: [{ field: 'order_no', label: '订单号', required: false }, { field: 'total_amount', label: '金额', required: true }, { field: 'currency', label: '币种', required: true }],
  tax_refund: [{ field: 'order_no', label: '订单号', required: false }, { field: 'refund_amount', label: '退税金额', required: true }, { field: 'status', label: '状态', required: false }],
  purchase_order: [{ field: 'supplier_name', label: '供应商', required: true }, { field: 'total_amount', label: '金额', required: true }, { field: 'currency', label: '币种', required: true }, { field: 'items', label: '明细', required: false }],
  payment_screenshot: [{ field: 'payer_name', label: '付款人', required: false }, { field: 'amount', label: '金额', required: true }, { field: 'currency', label: '币种', required: true }, { field: 'transaction_date', label: '日期', required: false }],
  expense_claim: [{ field: 'description', label: '描述', required: true }, { field: 'amount', label: '金额', required: true }, { field: 'currency', label: '币种', required: true }],
  contract: [{ field: 'party_a', label: '甲方', required: false }, { field: 'party_b', label: '乙方', required: false }, { field: 'total_amount', label: '金额', required: false }, { field: 'sign_date', label: '签约日期', required: false }],
  customer_statement: [{ field: 'customer_name', label: '客户', required: true }, { field: 'total_amount', label: '总金额', required: true }, { field: 'currency', label: '币种', required: true }],
  supplier_statement: [{ field: 'supplier_name', label: '供应商', required: true }, { field: 'total_amount', label: '总金额', required: true }, { field: 'currency', label: '币种', required: true }],
  factory_delivery: [{ field: 'factory_name', label: '工厂', required: true }, { field: 'items', label: '送货明细', required: false }, { field: 'total_amount', label: '金额', required: false }],
  fabric_order: [{ field: 'supplier_name', label: '供应商', required: true }, { field: 'items', label: '面料明细', required: false }, { field: 'total_amount', label: '金额', required: true }, { field: 'currency', label: '币种', required: true }],
  accessory_order: [{ field: 'supplier_name', label: '供应商', required: true }, { field: 'items', label: '辅料明细', required: false }, { field: 'total_amount', label: '金额', required: true }, { field: 'currency', label: '币种', required: true }],
}

// 文档主记录
export interface UploadedDocument {
  id: string
  file_name: string
  file_type: FileType
  file_size: number | null
  file_url: string | null
  doc_category: DocCategory | null
  doc_category_confidence: number | null
  status: DocStatus
  extracted_fields: Record<string, unknown>
  matched_order_id: string | null
  matched_customer: string | null
  matched_supplier: string | null
  template_id: string | null
  confirmed_by: string | null
  confirmed_at: string | null
  confirmation_changes: Record<string, { from: unknown; to: unknown }>  | null
  created_by: string | null
  created_at: string
}

// 模板记忆
export interface ExtractionTemplate {
  id: string
  template_name: string
  entity_name: string
  entity_type: 'customer' | 'supplier' | 'logistics' | 'bank'
  doc_category: DocCategory
  column_mapping: Record<string, string>
  field_positions: Record<string, unknown> | null
  sample_headers: string[] | null
  usage_count: number
  last_used_at: string
}

// 文档建议操作
export type DocumentActionType =
  | 'create_order'
  | 'create_budget'
  | 'create_payment_request'
  | 'link_cost_item'
  | 'update_receivable'
  | 'update_customer_credit'
  | 'update_cashflow'
  | 'update_shipping_status'
  | 'create_risk_check'

export const ACTION_TYPE_LABELS: Record<DocumentActionType, string> = {
  create_order: '创建订单', create_budget: '创建预算单',
  create_payment_request: '创建付款申请', link_cost_item: '关联费用',
  update_receivable: '更新应收', update_customer_credit: '更新客户信用',
  update_cashflow: '更新现金流', update_shipping_status: '更新出货状态',
  create_risk_check: '创建风险检查',
}

export interface DocumentAction {
  id: string
  document_id: string
  action_type: DocumentActionType
  action_data: Record<string, unknown>
  status: 'suggested' | 'confirmed' | 'executed' | 'rejected'
  executed_by: string | null
  executed_at: string | null
  created_at: string
}

// 匹配结果
export interface MatchResult {
  type: 'customer' | 'order' | 'supplier' | 'invoice' | 'duplicate' | 'shipping' | 'customs'
  confidence: number                     // 0-100
  confidence_level: 'high' | 'medium' | 'low'  // >80/50-80/<50
  matched_id: string | null
  matched_name: string
  detail: string
}

// 统一提取结果（增强版）
export interface ExtractionResult {
  success: boolean
  error?: string
  doc_category: DocCategory
  classification_confidence: number      // 0-100
  extracted_fields: Record<string, unknown>
  field_confidence: Record<string, number>  // 每个字段的置信度 0-100
  missing_fields: string[]               // 应有但未提取的字段
  high_risk_fields: string[]             // 必须人工确认的字段
  duplicate_probability: number          // 重复上传概率 0-100
  raw_text_summary: string
  template_match_result: string | null   // 匹配到的模板名
  extraction_method: 'vision' | 'excel' | 'template'
}

// 必须强制确认的字段
export const FORCED_CONFIRM_FIELDS = [
  'total_amount', 'amount', 'currency', 'qty',
  'customer_name', 'supplier_name', 'payer_name',
  'bank_account', 'invoice_no', 'po_number',
  'payment_terms', 'etd', 'eta',
]

// 结构化Explanation — 每步动作可解释
export interface ActionExplanation {
  summary: string
  triggered_by: string
  supporting_fields: string[]
  confidence_reason: string
  risk_reason: string
  approval_reason: string | null
  downgrade_reason: string | null
}

// 动作决定
export type ActionDecision = 'pending' | 'accepted' | 'rejected' | 'draft' | 'escalated'

// 准确率反馈事件
export type FeedbackEventType = 'field_corrected' | 'action_rejected' | 'action_rolled_back' | 'template_failed'

export interface AccuracyFeedbackEvent {
  id: string
  document_id: string | null
  event_type: FeedbackEventType
  field_name: string | null
  action_type: string | null
  original_value: string | null
  corrected_value: string | null
  doc_category: string | null
  entity_name: string | null
  created_at: string
}
