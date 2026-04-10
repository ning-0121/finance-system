// ============================================================
// Document Intelligence Engine — 自动匹配引擎
// 提取字段 → 匹配系统数据 → 生成建议操作
// ============================================================

import { createClient } from '@/lib/supabase/client'
import type { DocCategory, MatchResult, DocumentActionType } from '@/lib/types/document'

// --- 自动匹配 ---
export async function autoMatch(
  docCategory: DocCategory,
  fields: Record<string, unknown>
): Promise<MatchResult[]> {
  const results: MatchResult[] = []
  const supabase = createClient()

  // 1. 匹配客户
  const customerName = (fields.customer_name || fields.payer_name) as string | undefined
  if (customerName) {
    const { data } = await supabase
      .from('customers')
      .select('id, company')
      .ilike('company', `%${customerName}%`)
      .limit(3)

    if (data?.length) {
      results.push({
        type: 'customer',
        confidence: data[0].company.toLowerCase() === customerName.toLowerCase() ? 1.0 : 0.7,
        matched_id: data[0].id,
        matched_name: data[0].company,
        detail: `匹配客户: ${data[0].company}`,
      })
    }
  }

  // 2. 匹配供应商
  const supplierName = (fields.supplier_name || fields.factory_name || fields.logistics_company) as string | undefined
  if (supplierName) {
    const { data } = await supabase
      .from('supplier_financial_profiles')
      .select('id, supplier_name')
      .ilike('supplier_name', `%${supplierName}%`)
      .limit(3)

    if (data?.length) {
      results.push({
        type: 'supplier',
        confidence: 0.8,
        matched_id: data[0].id,
        matched_name: data[0].supplier_name,
        detail: `匹配供应商: ${data[0].supplier_name}`,
      })
    }
  }

  // 3. 匹配订单
  const poNumber = (fields.po_number || fields.order_no) as string | undefined
  if (poNumber) {
    const { data } = await supabase
      .from('budget_orders')
      .select('id, order_no')
      .or(`order_no.ilike.%${poNumber}%,notes.ilike.%${poNumber}%`)
      .limit(3)

    if (data?.length) {
      results.push({
        type: 'order',
        confidence: 0.9,
        matched_id: data[0].id,
        matched_name: data[0].order_no,
        detail: `匹配订单: ${data[0].order_no}`,
      })
    }
  }

  // 4. 发票去重检测
  const invoiceNo = fields.invoice_no as string | undefined
  if (invoiceNo) {
    const { data } = await supabase
      .from('actual_invoices')
      .select('id, invoice_no')
      .eq('invoice_no', invoiceNo)
      .limit(1)

    if (data?.length) {
      results.push({
        type: 'duplicate',
        confidence: 1.0,
        matched_id: data[0].id,
        matched_name: data[0].invoice_no,
        detail: `⚠️ 重复: 发票号 ${invoiceNo} 已存在`,
      })
    }
  }

  // 5. 金额去重
  const amount = fields.total_amount as number | undefined
  if (amount && supplierName) {
    const { data } = await supabase
      .from('cost_items')
      .select('id, description, amount')
      .eq('amount', amount)
      .ilike('description', `%${supplierName}%`)
      .limit(1)

    if (data?.length) {
      results.push({
        type: 'duplicate',
        confidence: 0.7,
        matched_id: data[0].id,
        matched_name: `${data[0].description}: $${data[0].amount}`,
        detail: `⚠️ 疑似重复: 相同供应商+金额已存在`,
      })
    }
  }

  return results
}

// --- 根据文件类别生成建议操作 ---
export function generateSuggestedActions(
  docCategory: DocCategory,
  fields: Record<string, unknown>,
  matches: MatchResult[]
): { action_type: DocumentActionType; action_data: Record<string, unknown> }[] {
  const actions: { action_type: DocumentActionType; action_data: Record<string, unknown> }[] = []
  const hasDuplicate = matches.some(m => m.type === 'duplicate' && m.confidence > 0.9)

  if (hasDuplicate) return actions // 重复文件不建议操作

  switch (docCategory) {
    case 'customer_po':
      actions.push({ action_type: 'create_order', action_data: { customer: fields.customer_name, po: fields.po_number, amount: fields.total_amount } })
      actions.push({ action_type: 'create_budget', action_data: { from: 'customer_po' } })
      actions.push({ action_type: 'create_risk_check', action_data: { customer: fields.customer_name } })
      break

    case 'supplier_invoice':
    case 'fabric_order':
    case 'accessory_order':
      actions.push({ action_type: 'create_payment_request', action_data: { supplier: fields.supplier_name, amount: fields.total_amount } })
      actions.push({ action_type: 'link_cost_item', action_data: { amount: fields.total_amount, type: 'procurement' } })
      break

    case 'bank_receipt':
    case 'payment_screenshot':
      actions.push({ action_type: 'update_receivable', action_data: { payer: fields.payer_name, amount: fields.amount } })
      actions.push({ action_type: 'update_customer_credit', action_data: { customer: fields.payer_name } })
      actions.push({ action_type: 'update_cashflow', action_data: { inflow: fields.amount } })
      break

    case 'logistics_bill':
      actions.push({ action_type: 'link_cost_item', action_data: { amount: fields.amount, type: 'freight' } })
      break

    case 'packing_list':
      actions.push({ action_type: 'update_shipping_status', action_data: { order: fields.order_no } })
      break

    case 'ci':
    case 'pi':
      actions.push({ action_type: 'update_shipping_status', action_data: { doc_type: docCategory } })
      break
  }

  return actions
}
