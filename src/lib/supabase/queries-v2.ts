// ============================================================
// V2 查询层 — 子单据 + 发票 + 出货 + 决算 + 汇总报表
// ============================================================

import { createClient } from './client'
import type {
  SubDocument, SubDocumentType, SubDocItem,
  ActualInvoice, ShippingDocument, InventoryReturn,
  OrderSettlement, SubSettlement, OrderLevelCost,
} from '@/lib/types'

// ============================================================
// 预算子单据 CRUD
// ============================================================

export async function getSubDocuments(budgetOrderId: string): Promise<SubDocument[]> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('budget_sub_documents')
      .select('*')
      .eq('budget_order_id', budgetOrderId)
      .order('created_at')

    if (error || !data) return []
    return data as SubDocument[]
  } catch {
    return []
  }
}

export async function createSubDocument(doc: {
  budget_order_id: string
  doc_type: SubDocumentType
  supplier_name?: string
  items: SubDocItem[]
  estimated_total: number
  currency: string
  exchange_rate: number
  notes?: string
}): Promise<{ data: SubDocument | null; error: string | null }> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('budget_sub_documents')
      .insert({
        ...doc,
        status: 'draft',
      })
      .select()
      .single()

    if (error) return { data: null, error: error.message }
    return { data: data as SubDocument, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export async function settleSubDocument(
  id: string,
  actualTotal: number,
  note?: string
): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()

    // 取预算金额算差异
    const { data: doc } = await supabase
      .from('budget_sub_documents')
      .select('estimated_total')
      .eq('id', id)
      .single()

    const variance = doc ? actualTotal - (doc.estimated_total || 0) : 0

    const { error } = await supabase
      .from('budget_sub_documents')
      .update({
        status: 'settled',
        actual_total: actualTotal,
        variance,
        settlement_note: note || null,
      })
      .eq('id', id)

    return { error: error?.message || null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

// ============================================================
// 实际发票 CRUD
// ============================================================

export async function getActualInvoices(budgetOrderId: string): Promise<ActualInvoice[]> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('actual_invoices')
      .select('*')
      .eq('budget_order_id', budgetOrderId)
      .order('created_at', { ascending: false })

    if (error || !data) return []
    return data as ActualInvoice[]
  } catch {
    return []
  }
}

export async function createActualInvoice(invoice: Partial<ActualInvoice>): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { error } = await supabase.from('actual_invoices').insert(invoice)
    return { error: error?.message || null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

// ============================================================
// 出货单据
// ============================================================

export async function getShippingDocuments(budgetOrderId: string): Promise<ShippingDocument[]> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('shipping_documents')
      .select('*')
      .eq('budget_order_id', budgetOrderId)
      .order('created_at')

    if (error || !data) return []
    return data as ShippingDocument[]
  } catch {
    return []
  }
}

// ============================================================
// 库存入库
// ============================================================

export async function getInventoryReturns(budgetOrderId: string): Promise<InventoryReturn[]> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('inventory_returns')
      .select('*')
      .eq('budget_order_id', budgetOrderId)

    if (error || !data) return []
    return data as InventoryReturn[]
  } catch {
    return []
  }
}

// ============================================================
// 订单决算
// ============================================================

export async function generateOrderSettlement(budgetOrderId: string): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()

    // 1. 获取所有已决算的子单据
    const { data: subDocs } = await supabase
      .from('budget_sub_documents')
      .select('*')
      .eq('budget_order_id', budgetOrderId)

    // 2. 获取订单级费用（cost_items中直接挂订单的）
    const { data: orderCosts } = await supabase
      .from('cost_items')
      .select('*')
      .eq('budget_order_id', budgetOrderId)
      .is('sub_document_id', null) // 注意：需先给cost_items添加此列

    // 3. 获取库存冲减
    const { data: returns } = await supabase
      .from('inventory_returns')
      .select('total_value, accounting_treatment')
      .eq('budget_order_id', budgetOrderId)

    // 4. 获取预算单总收入
    const { data: budget } = await supabase
      .from('budget_orders')
      .select('total_revenue')
      .eq('id', budgetOrderId)
      .single()

    // 计算
    const subSettlements: SubSettlement[] = (subDocs || []).map(d => ({
      sub_document_id: d.id,
      doc_type: d.doc_type,
      supplier_name: d.supplier_name,
      budgeted: d.estimated_total || 0,
      actual: d.actual_total || d.estimated_total || 0,
      variance: d.variance || 0,
      variance_pct: d.estimated_total ? Math.round(((d.variance || 0) / d.estimated_total) * 10000) / 100 : 0,
    }))

    const orderLevelCosts: OrderLevelCost[] = [
      { category: '运费', budgeted: 0, actual: 0, variance: 0 },
      { category: '佣金', budgeted: 0, actual: 0, variance: 0 },
      { category: '报关费', budgeted: 0, actual: 0, variance: 0 },
      { category: '税费', budgeted: 0, actual: 0, variance: 0 },
      { category: '其他', budgeted: 0, actual: 0, variance: 0 },
    ]

    // 填充订单级费用
    const costTypeMap: Record<string, string> = {
      freight: '运费', commission: '佣金', customs: '报关费', tax: '税费', other: '其他',
    }
    for (const c of (orderCosts || [])) {
      const cat = costTypeMap[c.cost_type] || '其他'
      const item = orderLevelCosts.find(o => o.category === cat)
      if (item) {
        item.actual += c.amount || 0
        item.variance = item.actual - item.budgeted
      }
    }

    const inventoryCredit = (returns || [])
      .filter(r => r.accounting_treatment === 'reduce_cost')
      .reduce((s, r) => s + (r.total_value || 0), 0)

    const totalBudget = subSettlements.reduce((s, d) => s + d.budgeted, 0) + orderLevelCosts.reduce((s, c) => s + c.budgeted, 0)
    const totalActual = subSettlements.reduce((s, d) => s + d.actual, 0) + orderLevelCosts.reduce((s, c) => s + c.actual, 0) - inventoryCredit
    const totalVariance = totalActual - totalBudget
    const totalRevenue = budget?.total_revenue || 0
    const finalProfit = totalRevenue - totalActual
    const finalMargin = totalRevenue > 0 ? Math.round((finalProfit / totalRevenue) * 10000) / 100 : 0

    // 5. Upsert 决算单
    const { error } = await supabase
      .from('order_settlements')
      .upsert({
        budget_order_id: budgetOrderId,
        sub_settlements: subSettlements,
        order_level_costs: orderLevelCosts,
        total_budget: totalBudget,
        total_actual: totalActual,
        total_variance: totalVariance,
        inventory_credit: inventoryCredit,
        final_profit: finalProfit,
        final_margin: finalMargin,
        status: 'draft',
      }, { onConflict: 'budget_order_id' })

    return { error: error?.message || null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export async function getOrderSettlement(budgetOrderId: string): Promise<OrderSettlement | null> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('order_settlements')
      .select('*')
      .eq('budget_order_id', budgetOrderId)
      .single()

    if (error || !data) return null
    return data as OrderSettlement
  } catch {
    return null
  }
}

// ============================================================
// 汇总报表查询
// ============================================================

export async function getSupplierStatements(filters?: {
  supplierName?: string
  startDate?: string
  endDate?: string
}): Promise<Record<string, unknown>[]> {
  try {
    const supabase = createClient()
    let query = supabase
      .from('actual_invoices')
      .select('supplier_name, total_amount, currency, status, invoice_date, invoice_no, budget_order_id')
      .not('supplier_name', 'is', null)
      .order('invoice_date', { ascending: false })

    if (filters?.supplierName) query = query.ilike('supplier_name', `%${filters.supplierName}%`)
    if (filters?.startDate) query = query.gte('invoice_date', filters.startDate)
    if (filters?.endDate) query = query.lte('invoice_date', filters.endDate)

    const { data, error } = await query
    if (error || !data) return []
    return data
  } catch {
    return []
  }
}

export async function getCommissionReport(filters?: {
  startDate?: string
  endDate?: string
}): Promise<Record<string, unknown>[]> {
  try {
    const supabase = createClient()
    let query = supabase
      .from('actual_invoices')
      .select('*, budget_orders(order_no, customer_id)')
      .eq('invoice_type', 'commission_bill')
      .order('invoice_date', { ascending: false })

    if (filters?.startDate) query = query.gte('invoice_date', filters.startDate)
    if (filters?.endDate) query = query.lte('invoice_date', filters.endDate)

    const { data, error } = await query
    if (error || !data) return []
    return data
  } catch {
    return []
  }
}
