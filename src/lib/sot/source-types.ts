// ============================================================
// Phase A-1: SoT (Single Source of Truth) — 类型定义
// ============================================================

/**
 * 字段来源类型 — 与 SQL CHECK constraint 对齐。
 * 修改时必须同步更新 migrations/phase-a/A-1-up.sql 中的
 * `chk_lineage_source_type` constraint。
 */
export type SotSourceType =
  | 'customer_po'         // 客户 PO 文件
  | 'quotation'           // 报价单
  | 'logistics_invoice'   // 物流账单
  | 'bank_statement'      // 银行回单
  | 'supplier_invoice'    // 供应商发票
  | 'packing_list'        // 装箱单
  | 'inbound_record'      // 入库单
  | 'manual_entry'        // 人工录入
  | 'derived'             // 系统派生计算
  | 'external_system'     // 外部系统同步（订单节拍器 / OMS / 财务接口...）

/** 12 个关键字段 — 文档化清单（实际写入时 target_field 是 string，不强制枚举） */
export const KEY_FIELDS = {
  PO_NUMBER:        { table: 'budget_orders',       field: 'po_number',                     label: 'PO 号' },
  TOTAL_REVENUE:    { table: 'budget_orders',       field: 'total_revenue',                 label: '订单金额' },
  CURRENCY:         { table: 'budget_orders',       field: 'currency',                      label: '币种' },
  TOTAL_COST:       { table: 'budget_orders',       field: 'total_cost',                    label: '成本' },
  ESTIMATED_MARGIN: { table: 'budget_orders',       field: 'estimated_margin',              label: '毛利率' },
  STYLE_QTY:        { table: 'profit_order_styles', field: 'qty',                           label: '数量' },
  STYLE_PRICE:      { table: 'profit_order_styles', field: 'selling_price_per_piece_usd',   label: '单价' },
  RECEIPT_AMOUNT:   { table: 'receipts',            field: 'amount',                        label: '回款金额' },
  PAYMENT_AMOUNT:   { table: 'payment_records',     field: 'amount',                        label: '付款金额' },
  FREIGHT:          { table: 'cost_items',          field: 'amount',                        label: '运费' },
  SHIPPED_QTY:      { table: 'shipping_records',    field: 'qty',                           label: '出货数量' },
  INBOUND_QTY:      { table: 'inbound_records',     field: 'qty',                           label: '入库数量' },
} as const

export type KeyFieldKey = keyof typeof KEY_FIELDS

export interface SotWriteParams {
  /** 必填：目标表名（snake_case，与 DB 一致）*/
  table: string
  /** 必填：目标行 id (uuid) */
  rowId: string
  /** 必填：字段名 */
  field: string
  /** 必填：写入的值（任意 JSON-serializable） */
  value: unknown

  /** 必填：来源类型 */
  sourceType: SotSourceType
  /** 来源实体名（如 'order_metronome' / 'styles_aggregation'） */
  sourceEntity?: string | null
  /** 来源原始单据 id（OCR 文档 / 银行流水 / PI 单 ...） */
  sourceDocumentId?: string | null
  /** 来源单据上的字段名（如 'po_total_amount'） */
  sourceField?: string | null

  /** 置信度 0~1，默认 1.0 */
  confidence?: number
  /** 验证人 profiles.id */
  verifiedBy?: string | null
  /** 是否允许人工 override 默认 true */
  allowManualOverride?: boolean
  /** 若为人工 override 必须给出原因 */
  overrideReason?: string | null

  /** 操作人 profiles.id；未提供则视为系统自动 */
  actorId?: string | null
  /** 操作时角色快照 */
  actorRole?: string | null
  /** 自定义 action（默认 'sot_shadow_write'） */
  action?: string
  /** 任意上下文（自动序列化为 jsonb） */
  context?: Record<string, unknown>

  /** 多租户：未提供时 helper 自动用当前 tenant id */
  tenantId?: string
}

export interface LineageRow {
  id: string
  tenant_id: string
  target_table: string
  target_row_id: string
  target_field: string
  target_field_value: unknown
  source_type: SotSourceType
  source_entity: string | null
  source_document_id: string | null
  source_field: string | null
  confidence: number
  last_verified_at: string | null
  verified_by: string | null
  allow_manual_override: boolean
  override_reason: string | null
  audit_event_id: string | null
  is_current: boolean
  superseded_by: string | null
  created_at: string
  updated_at: string
}
