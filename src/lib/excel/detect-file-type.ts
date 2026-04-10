// ============================================================
// 智能文件类型识别 — 根据Excel列名自动判断文件类型
// ============================================================

export type ImportFileType =
  | 'supplier_invoice'    // 供应商发票/对账单
  | 'freight_bill'        // 运费/物流账单
  | 'purchase_order'      // 采购单/PI
  | 'commercial_invoice'  // CI/商业发票
  | 'packing_list'        // 装箱单
  | 'internal_quote'      // 内部报价单
  | 'delivery_note'       // 送货单/码单
  | 'processing_fee'      // 加工费对账单
  | 'bank_receipt'        // 银行水单/回款
  | 'general_cost'        // 通用费用

const KEYWORD_MAP: Record<ImportFileType, string[]> = {
  supplier_invoice: ['发票号', '税额', '税率', '含税金额', '不含税', 'Invoice', '供应商', '开票'],
  freight_bill: ['运费', '柜号', '提单', '船名', '航次', 'Freight', 'B/L', '海运', '空运', '物流费'],
  purchase_order: ['采购单', 'PO', 'Purchase Order', '交货日期', '采购价', '供应商名称', 'PI'],
  commercial_invoice: ['CI', 'Commercial Invoice', 'FOB', 'CIF', 'HS Code', '品名', 'Description'],
  packing_list: ['箱号', 'Carton', '毛重', '净重', 'Gross Weight', 'Net Weight', '体积', 'CBM'],
  internal_quote: ['报价', 'Quote', '成本价', '售价', '利润率', '目标价'],
  delivery_note: ['送货单', '签收', '入库', '码单', '原辅料', '数量', '规格'],
  processing_fee: ['加工费', '工序', '单价', '数量', '工厂', '加工', '代工'],
  bank_receipt: ['银行', '水单', '汇款', '收款', 'TT', 'Wire Transfer', '到账', '回款'],
  general_cost: ['费用', '金额', '日期', '描述', '备注'],
}

// 文件类型 → 成本类型映射
export const FILE_TYPE_TO_COST_TYPE: Record<ImportFileType, string> = {
  supplier_invoice: 'procurement',
  freight_bill: 'freight',
  purchase_order: 'procurement',
  commercial_invoice: 'procurement',
  packing_list: 'other',
  internal_quote: 'other',
  delivery_note: 'procurement',
  processing_fee: 'procurement',
  bank_receipt: 'other',
  general_cost: 'other',
}

export const FILE_TYPE_LABELS: Record<ImportFileType, string> = {
  supplier_invoice: '供应商发票/对账单',
  freight_bill: '运费/物流账单',
  purchase_order: '采购单/PI',
  commercial_invoice: '商业发票(CI)',
  packing_list: '装箱单',
  internal_quote: '内部报价单',
  delivery_note: '送货单/码单',
  processing_fee: '加工费对账单',
  bank_receipt: '银行水单/回款',
  general_cost: '通用费用',
}

export interface DetectionResult {
  type: ImportFileType
  confidence: number
  matchedKeywords: string[]
}

export function detectFileType(headers: string[]): DetectionResult {
  const headerStr = headers.join(' ').toLowerCase()

  let bestType: ImportFileType = 'general_cost'
  let bestScore = 0
  let bestMatched: string[] = []

  for (const [type, keywords] of Object.entries(KEYWORD_MAP)) {
    const matched = keywords.filter(kw => headerStr.includes(kw.toLowerCase()))
    const score = matched.length / keywords.length

    if (score > bestScore) {
      bestScore = score
      bestType = type as ImportFileType
      bestMatched = matched
    }
  }

  return {
    type: bestType,
    confidence: Math.min(bestScore * 1.5, 1), // 放大置信度但不超过1
    matchedKeywords: bestMatched,
  }
}
