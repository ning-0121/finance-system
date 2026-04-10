// ============================================================
// Document Intelligence Engine — 增强版匹配+建议引擎
// 6种匹配场景 + 置信度分级(high/medium/low) + 18种文件全覆盖建议
// ============================================================

import { createClient } from '@/lib/supabase/client'
import type { DocCategory, MatchResult, DocumentActionType } from '@/lib/types/document'

function toLevel(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 80) return 'high'
  if (confidence >= 50) return 'medium'
  return 'low'
}

// ============================================================
// 自动匹配引擎（6种场景）
// ============================================================
export async function autoMatch(
  docCategory: DocCategory,
  fields: Record<string, unknown>
): Promise<MatchResult[]> {
  const results: MatchResult[] = []
  const supabase = createClient()

  // 1. 客户匹配
  const customerName = (fields.customer_name || fields.payer_name) as string | undefined
  if (customerName) {
    const { data } = await supabase.from('customers').select('id, company').ilike('company', `%${customerName}%`).limit(3)
    if (data?.length) {
      const exact = data[0].company.toLowerCase() === customerName.toLowerCase()
      const conf = exact ? 95 : 70
      results.push({ type: 'customer', confidence: conf, confidence_level: toLevel(conf), matched_id: data[0].id, matched_name: data[0].company, detail: `匹配客户: ${data[0].company}` })
    }
  }

  // 2. 供应商匹配
  const supplierName = (fields.supplier_name || fields.factory_name || fields.logistics_company) as string | undefined
  if (supplierName) {
    const { data } = await supabase.from('supplier_financial_profiles').select('id, supplier_name').ilike('supplier_name', `%${supplierName}%`).limit(3)
    if (data?.length) {
      const conf = data[0].supplier_name.includes(supplierName) ? 85 : 60
      results.push({ type: 'supplier', confidence: conf, confidence_level: toLevel(conf), matched_id: data[0].id, matched_name: data[0].supplier_name, detail: `匹配供应商: ${data[0].supplier_name}` })
    }
  }

  // 3. 订单/PO匹配
  const poNumber = (fields.po_number || fields.order_no || fields.pi_no) as string | undefined
  if (poNumber) {
    const { data } = await supabase.from('budget_orders').select('id, order_no').or(`order_no.ilike.%${poNumber}%,notes.ilike.%${poNumber}%`).limit(3)
    if (data?.length) {
      results.push({ type: 'order', confidence: 90, confidence_level: 'high', matched_id: data[0].id, matched_name: data[0].order_no, detail: `匹配订单: ${data[0].order_no}` })
    }
  }

  // 4. 发票去重检测
  const invoiceNo = (fields.invoice_no || fields.reference_no) as string | undefined
  if (invoiceNo) {
    const { data } = await supabase.from('actual_invoices').select('id, invoice_no').eq('invoice_no', invoiceNo).limit(1)
    if (data?.length) {
      results.push({ type: 'duplicate', confidence: 100, confidence_level: 'high', matched_id: data[0].id, matched_name: data[0].invoice_no, detail: `⚠️ 重复: 发票号 ${invoiceNo} 已存在` })
    }
  }

  // 5. 出货单据匹配（装箱单/报关单/退税单）
  if (['packing_list', 'customs_declaration', 'tax_refund'].includes(docCategory)) {
    const orderNo = (fields.order_no || poNumber) as string | undefined
    if (orderNo) {
      const { data } = await supabase.from('shipping_documents').select('id, document_no, doc_type').eq('budget_order_id', orderNo).limit(5)
      if (data?.length) {
        results.push({ type: 'shipping', confidence: 75, confidence_level: 'medium', matched_id: data[0].id, matched_name: data[0].document_no, detail: `匹配出货单据: ${data[0].document_no} (${data[0].doc_type})` })
      }
    }
  }

  // 6. 金额+供应商组合去重
  const amount = fields.total_amount as number | undefined
  if (amount && (supplierName || customerName)) {
    const searchName = supplierName || customerName || ''
    const { data } = await supabase.from('cost_items').select('id, description, amount').eq('amount', amount).ilike('description', `%${searchName}%`).limit(1)
    if (data?.length) {
      results.push({ type: 'duplicate', confidence: 70, confidence_level: 'medium', matched_id: data[0].id, matched_name: `${data[0].description}: $${data[0].amount}`, detail: `⚠️ 疑似重复: 相同金额+名称已存在` })
    }
  }

  return results
}

// ============================================================
// 重复概率计算
// ============================================================
export async function calculateDuplicateProbability(
  fileName: string,
  fileSize: number | null,
  fields: Record<string, unknown>
): Promise<number> {
  const supabase = createClient()
  let score = 0

  // 同名文件检测
  const { data: sameFile } = await supabase.from('uploaded_documents').select('id').eq('file_name', fileName).limit(1)
  if (sameFile?.length) score += 40

  // 同名+同大小
  if (fileSize && sameFile?.length) {
    const { data: exact } = await supabase.from('uploaded_documents').select('id').eq('file_name', fileName).eq('file_size', fileSize).limit(1)
    if (exact?.length) score += 40
  }

  // 同发票号
  const invoiceNo = fields.invoice_no as string
  if (invoiceNo) {
    const { data } = await supabase.from('uploaded_documents').select('id').contains('extracted_fields', { invoice_no: invoiceNo }).limit(1)
    if (data?.length) score += 30
  }

  return Math.min(score, 100)
}

// ============================================================
// 建议引擎（全18种文件类别覆盖）
// ============================================================
export function generateSuggestedActions(
  docCategory: DocCategory,
  fields: Record<string, unknown>,
  matches: MatchResult[]
): { action_type: DocumentActionType; action_data: Record<string, unknown>; description: string }[] {
  const actions: { action_type: DocumentActionType; action_data: Record<string, unknown>; description: string }[] = []
  const hasDuplicate = matches.some(m => m.type === 'duplicate' && m.confidence >= 90)

  if (hasDuplicate) {
    return [{ action_type: 'create_risk_check' as DocumentActionType, action_data: { reason: 'duplicate_document' }, description: '检测到重复文件，建议检查后再操作' }]
  }

  const f = fields

  switch (docCategory) {
    case 'customer_po':
      actions.push({ action_type: 'create_order', action_data: { customer: f.customer_name, po: f.po_number, amount: f.total_amount }, description: '创建订单草稿' })
      actions.push({ action_type: 'create_budget', action_data: { from: 'customer_po', amount: f.total_amount }, description: '创建预算单' })
      actions.push({ action_type: 'create_risk_check', action_data: { customer: f.customer_name }, description: '运行财务预审检查' })
      break

    case 'pi':
      actions.push({ action_type: 'update_shipping_status', action_data: { doc_type: 'pi', amount: f.total_amount }, description: '更新出货状态(PI已生成)' })
      actions.push({ action_type: 'update_receivable', action_data: { customer: f.customer_name, amount: f.total_amount }, description: '创建应收计划' })
      break

    case 'ci':
      actions.push({ action_type: 'update_shipping_status', action_data: { doc_type: 'ci', amount: f.total_amount }, description: '更新出货状态(CI已生成)' })
      break

    case 'supplier_invoice':
    case 'fabric_order':
    case 'accessory_order':
    case 'purchase_order':
      actions.push({ action_type: 'create_payment_request', action_data: { supplier: f.supplier_name, amount: f.total_amount, invoice_no: f.invoice_no }, description: '创建付款申请' })
      actions.push({ action_type: 'link_cost_item', action_data: { amount: f.total_amount, type: 'procurement' }, description: '关联采购成本' })
      break

    case 'bank_receipt':
    case 'payment_screenshot':
      actions.push({ action_type: 'update_receivable', action_data: { payer: f.payer_name || f.customer_name, amount: f.amount || f.total_amount }, description: '登记回款' })
      actions.push({ action_type: 'update_customer_credit', action_data: { customer: f.payer_name || f.customer_name }, description: '更新客户信用' })
      actions.push({ action_type: 'update_cashflow', action_data: { inflow: f.amount || f.total_amount }, description: '更新现金流预测' })
      break

    case 'logistics_bill':
      actions.push({ action_type: 'link_cost_item', action_data: { amount: f.amount || f.total_amount, type: 'freight' }, description: '关联运费成本' })
      actions.push({ action_type: 'create_payment_request', action_data: { supplier: f.logistics_company, amount: f.amount }, description: '创建运费付款申请' })
      break

    case 'packing_list':
      actions.push({ action_type: 'update_shipping_status', action_data: { order: f.order_no, cartons: f.carton_count, weight: f.gross_weight }, description: '更新出货装箱信息' })
      actions.push({ action_type: 'create_risk_check', action_data: { type: 'pre_shipment' }, description: '运行出货前财务检查' })
      break

    case 'customs_declaration':
      actions.push({ action_type: 'update_shipping_status', action_data: { doc_type: 'customs', amount: f.total_amount }, description: '更新报关状态' })
      actions.push({ action_type: 'link_cost_item', action_data: { type: 'customs', amount: f.total_amount }, description: '关联报关费用' })
      break

    case 'tax_refund':
      actions.push({ action_type: 'update_cashflow', action_data: { inflow: f.refund_amount || f.total_amount, type: 'tax_refund' }, description: '更新退税到账预测' })
      break

    case 'contract':
      actions.push({ action_type: 'create_order', action_data: { customer: f.party_a || f.party_b, amount: f.total_amount }, description: '基于合同创建订单' })
      break

    case 'customer_statement':
      actions.push({ action_type: 'update_receivable', action_data: { customer: f.customer_name, amount: f.total_amount }, description: '核对客户对账' })
      break

    case 'supplier_statement':
      actions.push({ action_type: 'create_payment_request', action_data: { supplier: f.supplier_name, amount: f.total_amount }, description: '核对供应商对账' })
      break

    case 'factory_delivery':
      actions.push({ action_type: 'link_cost_item', action_data: { supplier: f.factory_name, amount: f.total_amount, type: 'procurement' }, description: '关联加工费成本' })
      break

    case 'expense_claim':
      actions.push({ action_type: 'link_cost_item', action_data: { amount: f.amount || f.total_amount, type: 'other' }, description: '录入报销费用' })
      break
  }

  return actions
}
