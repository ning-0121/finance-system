// ============================================================
// V2 查询层 — 子单据 + 发票 + 出货 + 决算 + 汇总报表
// ============================================================

import { createClient } from './client'
import { fetchAll } from './fetch-all'
import type {
  SubDocument, SubDocumentType, SubDocItem,
  ActualInvoice, ShippingDocument, InventoryReturn,
  OrderSettlement, SubSettlement, OrderLevelCost,
  PayableRecord, SupplierPayment, Supplier,
  ReceivablePayment, ReceivablePaymentAllocation,
} from '@/lib/types'

// ============================================================
// 回款流水层（应收财务化）：流水 + 匹配分配
// ============================================================
export async function getReceivablePayments(): Promise<ReceivablePayment[]> {
  try {
    const supabase = createClient()
    const { data, error } = await fetchAll<ReceivablePayment>((from, to) => supabase
      .from('receivable_payments').select('*').is('voided_at', null)
      .order('received_at', { ascending: false }).order('id', { ascending: true })
      .range(from, to))
    if (error || !data) return []
    return data
  } catch { return [] }
}

export async function getReceivableAllocations(): Promise<ReceivablePaymentAllocation[]> {
  try {
    const supabase = createClient()
    const { data, error } = await fetchAll<ReceivablePaymentAllocation>((from, to) => supabase
      .from('receivable_payment_allocations').select('*').is('voided_at', null)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(from, to))
    if (error || !data) return []
    return data
  } catch { return [] }
}

export async function createReceivablePayment(p: {
  customer_id?: string | null; customer_name?: string | null; budget_order_id?: string | null
  amount_original: number; currency?: string; exchange_rate?: number
  received_at?: string | null; bank_account?: string | null; payment_reference?: string | null
  source_type?: ReceivablePayment['source_type']; notes?: string | null
}): Promise<{ data: ReceivablePayment | null; error: string | null }> {
  try {
    const supabase = createClient()
    const { data: userData } = await supabase.auth.getUser()
    const rate = p.currency && p.currency !== 'CNY' ? (Number(p.exchange_rate) || 1) : 1
    const amountCny = Math.round((Number(p.amount_original) || 0) * rate * 100) / 100
    const { data, error } = await supabase.from('receivable_payments').insert({
      customer_id: p.customer_id || null,
      customer_name: p.customer_name?.trim() || null,
      budget_order_id: p.budget_order_id || null,
      amount_original: Number(p.amount_original) || 0,
      currency: p.currency || 'CNY',
      exchange_rate: rate,
      amount_cny: amountCny,
      received_at: p.received_at || null,
      bank_account: p.bank_account?.trim() || null,
      payment_reference: p.payment_reference?.trim() || null,
      source_type: p.source_type || 'manual',
      notes: p.notes?.trim() || null,
      created_by: userData?.user?.id || null,
      updated_by: userData?.user?.id || null,
    }).select().single()
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return { data: null, error: '该回款（同客户/银行/日期/金额/流水号）已存在，请勿重复录入' }
      return { data: null, error: error.message }
    }
    return { data: data as ReceivablePayment, error: null }
  } catch (e) { return { data: null, error: e instanceof Error ? e.message : '未知错误' } }
}

// 作废整笔回款（RPC：连同分配一起 void + 回写 projection）
export async function voidReceivablePayment(id: string, reason?: string): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { data: userData } = await supabase.auth.getUser()
    const { error } = await supabase.rpc('void_receivable_payment', { p_receipt_id: id, p_actor: userData?.user?.id || null, p_reason: reason || null })
    return { error: error?.message || null }
  } catch (e) { return { error: e instanceof Error ? e.message : '未知错误' } }
}

// 匹配（RPC：事务内校验金额/订单/未作废 + 防超分配 + 自动状态 + 回写 projection）
export async function allocateReceipt(a: {
  receipt_id: string; budget_order_id: string; amount_cny: number; amount_original?: number | null
}): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { data: userData } = await supabase.auth.getUser()
    const { error } = await supabase.rpc('allocate_receivable_payment', {
      p_receipt_id: a.receipt_id, p_budget_order_id: a.budget_order_id,
      p_amount_cny: Math.round((Number(a.amount_cny) || 0) * 100) / 100,
      p_amount_original: a.amount_original != null ? Number(a.amount_original) : null,
      p_actor: userData?.user?.id || null,
    })
    return { error: error?.message || null }
  } catch (e) { return { error: e instanceof Error ? e.message : '未知错误' } }
}

// 撤销匹配（RPC：void 分配 + 自动状态 + 回写 projection）
export async function unallocateReceipt(allocationId: string, reason?: string): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { data: userData } = await supabase.auth.getUser()
    const { error } = await supabase.rpc('unallocate_receivable_payment', { p_allocation_id: allocationId, p_actor: userData?.user?.id || null, p_reason: reason || null })
    return { error: error?.message || null }
  } catch (e) { return { error: e instanceof Error ? e.message : '未知错误' } }
}

// ============================================================
// 供应商信息库（主数据）CRUD
// ============================================================
export async function getSuppliers(): Promise<Supplier[]> {
  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .is('deleted_at', null)
      .order('name', { ascending: true })
    if (error || !data) return []
    return data as Supplier[]
  } catch { return [] }
}

export async function upsertSupplier(s: Partial<Supplier> & { name: string }): Promise<{ data: Supplier | null; error: string | null }> {
  try {
    const supabase = createClient()
    const payload = {
      name: s.name.trim(),
      account_no: s.account_no?.trim() || null,
      account_name: s.account_name?.trim() || null,
      bank_name: s.bank_name?.trim() || null,
      contact: s.contact?.trim() || null,
      phone: s.phone?.trim() || null,
      attachment_url: s.attachment_url?.trim() || null,
      notes: s.notes?.trim() || null,
      updated_at: new Date().toISOString(),
    }
    if (s.id) {
      const { data, error } = await supabase.from('suppliers').update(payload).eq('id', s.id).select().single()
      return { data: (data as Supplier) ?? null, error: error?.message ?? null }
    }
    const { data: userData } = await supabase.auth.getUser()
    const { data, error } = await supabase.from('suppliers')
      .insert({ ...payload, created_by: userData?.user?.id || null })
      .select().single()
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return { data: null, error: `供应商「${payload.name}」已存在` }
      return { data: null, error: error.message }
    }
    return { data: data as Supplier, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : '未知错误' }
  }
}

export async function deleteSupplier(id: string): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { error } = await supabase.from('suppliers').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    return { error: error?.message || null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '未知错误' }
  }
}

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

    // 2. 获取订单级费用（cost_items中直接挂订单的）；必须排除已软删的费用
    const { data: orderCosts } = await supabase
      .from('cost_items')
      .select('*')
      .eq('budget_order_id', budgetOrderId)
      .is('sub_document_id', null) // 注意：需先给cost_items添加此列
      .is('deleted_at', null)

    // 3. 获取库存冲减
    const { data: returns } = await supabase
      .from('inventory_returns')
      .select('total_value, accounting_treatment')
      .eq('budget_order_id', budgetOrderId)

    // 4. 获取预算单（收入 + 订单级预算费用，用于预算侧回填与折汇）
    const { data: budget } = await supabase
      .from('budget_orders')
      .select('total_revenue, currency, exchange_rate, estimated_freight, estimated_commission, estimated_customs_fee, other_costs')
      .eq('id', budgetOrderId)
      .single()

    // 决算单全部以人民币口径计算（与展示层「实际利润 (CNY)」一致）
    const r2 = (n: number) => Math.round(n * 100) / 100
    const toCny = (amount: number | null | undefined, currency?: string | null, rate?: number | null) =>
      (Number(amount) || 0) * ((currency || 'CNY') === 'CNY' ? 1 : (Number(rate) || 1))
    const orderRate = budget?.currency === 'CNY' ? 1 : (Number(budget?.exchange_rate) || 1)

    // 计算（用 ?? 而非 ||：实际为 0 是真实决算值，不能回退到预算）
    const subSettlements: SubSettlement[] = (subDocs || []).map(d => {
      const budgeted = r2(toCny(d.estimated_total, d.currency, d.exchange_rate))
      const actual = r2(toCny(d.actual_total ?? d.estimated_total, d.currency, d.exchange_rate))
      return {
        sub_document_id: d.id,
        doc_type: d.doc_type,
        supplier_name: d.supplier_name,
        budgeted,
        actual,
        variance: r2(actual - budgeted),
        variance_pct: budgeted ? Math.round(((actual - budgeted) / budgeted) * 10000) / 100 : 0,
      }
    })

    // 订单级预算回填：与编辑页口径一致（estimated_commission=加工费、freight=运费、customs_fee=报关费、other_costs=其他）
    const orderLevelCosts: OrderLevelCost[] = [
      { category: '面料', budgeted: 0, actual: 0, variance: 0 },
      { category: '辅料', budgeted: 0, actual: 0, variance: 0 },
      { category: '运费', budgeted: r2(toCny(budget?.estimated_freight, budget?.currency, budget?.exchange_rate)), actual: 0, variance: 0 },
      { category: '加工费', budgeted: r2(toCny(budget?.estimated_commission, budget?.currency, budget?.exchange_rate)), actual: 0, variance: 0 },
      { category: '报关费', budgeted: r2(toCny(budget?.estimated_customs_fee, budget?.currency, budget?.exchange_rate)), actual: 0, variance: 0 },
      { category: '税费', budgeted: 0, actual: 0, variance: 0 },
      { category: '其他', budgeted: r2(toCny(budget?.other_costs, budget?.currency, budget?.exchange_rate)), actual: 0, variance: 0 },
    ]

    // 填充订单级费用（cost_type 映射与订单详情/决算页 CT2CAT 对齐；金额逐条按自身币种折人民币）
    const costTypeMap: Record<string, string> = {
      fabric: '面料', accessory: '辅料',
      freight: '运费', forwarder: '运费',
      commission: '加工费', processing: '加工费',
      customs: '报关费', container: '报关费',
      tax: '税费', logistics: '其他', other: '其他',
    }
    for (const c of (orderCosts || [])) {
      const cat = costTypeMap[c.cost_type] || '其他'
      const item = orderLevelCosts.find(o => o.category === cat)
      if (item) {
        item.actual = r2(item.actual + toCny(c.amount, c.currency, c.exchange_rate ?? orderRate))
        item.variance = r2(item.actual - item.budgeted)
      }
    }

    const inventoryCredit = (returns || [])
      .filter(r => r.accounting_treatment === 'reduce_cost')
      .reduce((s, r) => s + (r.total_value || 0), 0)

    const totalBudget = r2(subSettlements.reduce((s, d) => s + d.budgeted, 0) + orderLevelCosts.reduce((s, c) => s + c.budgeted, 0))
    const totalActual = r2(subSettlements.reduce((s, d) => s + d.actual, 0) + orderLevelCosts.reduce((s, c) => s + c.actual, 0) - inventoryCredit)
    const totalVariance = r2(totalActual - totalBudget)
    // 收入折人民币后再减成本（修复：USD 收入与人民币成本混减）
    const totalRevenue = r2(toCny(budget?.total_revenue, budget?.currency, budget?.exchange_rate))
    const finalProfit = r2(totalRevenue - totalActual)
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
// 应付自动生成（从决算中剥离）
// ============================================================

export async function generatePayablesFromSettlement(budgetOrderId: string): Promise<{ created: number; error: string | null }> {
  try {
    const supabase = createClient()

    // 1. 获取决算单
    const { data: settlement } = await supabase
      .from('order_settlements')
      .select('id, status')
      .eq('budget_order_id', budgetOrderId)
      .single()

    if (!settlement) return { created: 0, error: '决算单不存在' }
    if (settlement.status !== 'confirmed' && settlement.status !== 'locked') {
      return { created: 0, error: '决算单未确认，不能生成应付' }
    }

    // 2. 获取该订单的所有实际发票（已确认但未付的）
    const { data: invoices } = await supabase
      .from('actual_invoices')
      .select('id, invoice_no, supplier_name, invoice_type, total_amount, currency, due_date, status, sub_document_id')
      .eq('budget_order_id', budgetOrderId)
      .in('status', ['approved', 'pending'])

    if (!invoices?.length) return { created: 0, error: null }

    // 3. 获取预算子单据（用于对比超支）
    const { data: subDocs } = await supabase
      .from('budget_sub_documents')
      .select('id, doc_type, estimated_total')
      .eq('budget_order_id', budgetOrderId)

    const subDocMap = new Map<string, number>()
    subDocs?.forEach(d => subDocMap.set(d.id, d.estimated_total || 0))

    // 4. 获取订单号
    const { data: order } = await supabase
      .from('budget_orders')
      .select('order_no')
      .eq('id', budgetOrderId)
      .single()

    // 5. 检查已有应付记录（防重复）
    const { data: existing } = await supabase
      .from('payable_records')
      .select('invoice_id')
      .eq('budget_order_id', budgetOrderId)

    const existingInvoiceIds = new Set((existing || []).map(e => e.invoice_id))

    // 6. 生成应付记录
    const invoiceTypeToCostCategory: Record<string, string> = {
      purchase_order: 'raw_material', supplier_invoice: 'raw_material',
      factory_contract: 'factory', factory_statement: 'factory',
      freight_bill: 'freight', commission_bill: 'commission',
      tax_invoice: 'tax', other_invoice: 'other',
    }

    let created = 0
    for (const inv of invoices) {
      if (existingInvoiceIds.has(inv.id)) continue // 已有应付，跳过

      const budgetAmount = inv.sub_document_id ? subDocMap.get(inv.sub_document_id) || null : null
      const overBudget = budgetAmount !== null && inv.total_amount > budgetAmount

      const { error } = await supabase.from('payable_records').insert({
        budget_order_id: budgetOrderId,
        settlement_id: settlement.id,
        invoice_id: inv.id,
        order_no: order?.order_no || null,
        supplier_name: inv.supplier_name || '未知供应商',
        description: `${inv.invoice_no} - ${inv.supplier_name || ''}`,
        cost_category: invoiceTypeToCostCategory[inv.invoice_type] || 'other',
        amount: inv.total_amount,
        currency: inv.currency,
        budget_amount: budgetAmount,
        over_budget: overBudget,
        due_date: inv.due_date,
        payment_status: 'unpaid',
      })

      if (!error) created++
    }

    return { created, error: null }
  } catch (e) {
    return { created: 0, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

// 获取应付记录列表
export async function getPayableRecords(filters?: {
  budgetOrderId?: string
  paymentStatus?: string
  supplierName?: string
}): Promise<PayableRecord[]> {
  try {
    const supabase = createClient()
    const { data, error } = await fetchAll<PayableRecord>((from, to) => {
      let query = supabase
        .from('payable_records')
        .select('*')
        .order('created_at', { ascending: false }).order('id', { ascending: true })
      if (filters?.budgetOrderId) query = query.eq('budget_order_id', filters.budgetOrderId)
      if (filters?.paymentStatus) query = query.eq('payment_status', filters.paymentStatus)
      if (filters?.supplierName) query = query.ilike('supplier_name', `%${filters.supplierName}%`)
      return query.range(from, to)
    })
    if (error || !data) return []
    return data
  } catch {
    return []
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
    const { data, error } = await fetchAll<Record<string, unknown>>((from, to) => {
      let query = supabase
        .from('actual_invoices')
        .select('supplier_name, total_amount, currency, status, invoice_date, invoice_no, budget_order_id')
        .not('supplier_name', 'is', null)
        .order('invoice_date', { ascending: false }).order('id', { ascending: true })
      if (filters?.supplierName) query = query.ilike('supplier_name', `%${filters.supplierName}%`)
      if (filters?.startDate) query = query.gte('invoice_date', filters.startDate)
      if (filters?.endDate) query = query.lte('invoice_date', filters.endDate)
      return query.range(from, to)
    })
    if (error || !data) return []
    return data
  } catch {
    return []
  }
}

// ============================================================
// 供应商付款流水（对账单负数行）
// ============================================================

export async function getSupplierPayments(filters?: {
  supplierName?: string
  startDate?: string
  endDate?: string
}): Promise<SupplierPayment[]> {
  try {
    const supabase = createClient()
    const { data, error } = await fetchAll<SupplierPayment>((from, to) => {
      let query = supabase
        .from('supplier_payments')
        .select('*')
        .is('deleted_at', null)
        .order('paid_at', { ascending: true }).order('id', { ascending: true })
      if (filters?.supplierName) query = query.ilike('supplier_name', `%${filters.supplierName}%`)
      if (filters?.startDate) query = query.gte('paid_at', filters.startDate)
      if (filters?.endDate) query = query.lte('paid_at', filters.endDate)
      return query.range(from, to)
    })
    if (error || !data) return []
    return data
  } catch {
    return []
  }
}

export async function createSupplierPayment(payment: {
  supplier_name: string
  amount: number
  currency?: string
  paid_at?: string | null
  note?: string | null
}): Promise<{ data: SupplierPayment | null; error: string | null }> {
  try {
    const supabase = createClient()
    const { data: userData } = await supabase.auth.getUser()
    const { data, error } = await supabase
      .from('supplier_payments')
      .insert({
        supplier_name: payment.supplier_name,
        amount: payment.amount,
        currency: payment.currency || 'CNY',
        paid_at: payment.paid_at || null,
        note: payment.note || null,
        created_by: userData?.user?.id || null,
      })
      .select()
      .single()
    if (error) return { data: null, error: error.message }
    return { data: data as SupplierPayment, error: null }
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export async function deleteSupplierPayment(id: string): Promise<{ error: string | null }> {
  try {
    const supabase = createClient()
    const { error } = await supabase
      .from('supplier_payments')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    return { error: error?.message || null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
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
