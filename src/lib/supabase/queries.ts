// ============================================================
// Supabase 数据服务层 — 所有数据库读写操作
// 带 demo data fallback：当Supabase未配置或查询为空时用演示数据
// ============================================================

import { createClient } from './client'
import {
  demoBudgetOrders,
  demoSettlementOrders,
  demoCustomers,
  demoProducts,
  demoAlerts,
  demoApprovalLogs,
  demoProfitSummary,
  demoMonthlyProfit,
} from '@/lib/demo-data'
import type {
  BudgetOrder,
  SettlementOrder,
  Customer,
  Product,
  Alert,
  ApprovalLog,
  BudgetOrderStatus,
  ProfitSummary,
} from '@/lib/types'

function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  return !!url && url !== 'your_supabase_url_here'
}

// ============================================================
// 预算单 CRUD
// ============================================================

export async function getBudgetOrders(statusFilter?: string): Promise<BudgetOrder[]> {
  if (!isSupabaseConfigured()) return demoBudgetOrders

  try {
    const supabase = createClient()
    let query = supabase
      .from('budget_orders')
      .select('*, customers(*)')
      .order('created_at', { ascending: false })

    if (statusFilter && statusFilter !== 'all') {
      query = query.eq('status', statusFilter)
    }

    const { data, error } = await query
    if (error) throw error
    if (!data || data.length === 0) return demoBudgetOrders

    return data.map(mapDbBudgetOrder)
  } catch (e) {
    console.error('getBudgetOrders error:', e)
    return demoBudgetOrders
  }
}

export async function getBudgetOrderById(id: string): Promise<BudgetOrder | null> {
  if (!isSupabaseConfigured()) {
    return demoBudgetOrders.find(o => o.id === id) || null
  }

  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('budget_orders')
      .select('*, customers(*)')
      .eq('id', id)
      .single()

    if (error) throw error
    if (!data) return demoBudgetOrders.find(o => o.id === id) || null

    return mapDbBudgetOrder(data)
  } catch (e) {
    console.error('getBudgetOrderById error:', e)
    return demoBudgetOrders.find(o => o.id === id) || null
  }
}

export async function createBudgetOrder(order: Partial<BudgetOrder>): Promise<{ data: BudgetOrder | null; error: string | null }> {
  if (!isSupabaseConfigured()) {
    return { data: null, error: 'Supabase not configured (demo mode)' }
  }

  try {
    const supabase = createClient()
    const { data: userData } = await supabase.auth.getUser()

    const { data, error } = await supabase
      .from('budget_orders')
      .insert({
        order_no: '', // 触发器自动生成
        customer_id: order.customer_id,
        order_date: order.order_date,
        delivery_date: order.delivery_date || null,
        items: order.items || [],
        target_purchase_price: order.target_purchase_price || 0,
        estimated_freight: order.estimated_freight || 0,
        estimated_commission: order.estimated_commission || 0,
        estimated_customs_fee: order.estimated_customs_fee || 0,
        other_costs: order.other_costs || 0,
        total_revenue: order.total_revenue || 0,
        total_cost: order.total_cost || 0,
        estimated_profit: order.estimated_profit || 0,
        estimated_margin: order.estimated_margin || 0,
        currency: order.currency || 'USD',
        exchange_rate: order.exchange_rate || 1,
        status: order.status || 'draft',
        created_by: userData?.user?.id || '00000000-0000-0000-0000-000000000000',
        notes: order.notes || null,
      })
      .select()
      .single()

    if (error) return { data: null, error: error.message }
    return { data: mapDbBudgetOrder(data), error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return { data: null, error: msg }
  }
}

export async function updateBudgetOrderStatus(
  id: string,
  status: BudgetOrderStatus,
  approvedBy?: string
): Promise<{ error: string | null }> {
  if (!isSupabaseConfigured()) {
    return { error: null } // Demo mode: pretend success
  }

  try {
    const supabase = createClient()
    const updateData: Record<string, unknown> = { status }
    if (status === 'approved' && approvedBy) {
      updateData.approved_by = approvedBy
      updateData.approved_at = new Date().toISOString()
    }

    const { error } = await supabase
      .from('budget_orders')
      .update(updateData)
      .eq('id', id)

    return { error: error?.message || null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export async function createApprovalLog(log: Partial<ApprovalLog>): Promise<{ error: string | null }> {
  if (!isSupabaseConfigured()) return { error: null }

  try {
    const supabase = createClient()
    const { error } = await supabase
      .from('approval_logs')
      .insert({
        entity_type: log.entity_type,
        entity_id: log.entity_id,
        action: log.action,
        from_status: log.from_status,
        to_status: log.to_status,
        operator_id: log.operator_id || '00000000-0000-0000-0000-000000000000',
        comment: log.comment || null,
      })

    return { error: error?.message || null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

// ============================================================
// 结算单
// ============================================================

export async function getSettlementByBudgetId(budgetOrderId: string): Promise<SettlementOrder | null> {
  if (!isSupabaseConfigured()) {
    return demoSettlementOrders.find(s => s.budget_order_id === budgetOrderId) || null
  }

  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('settlement_orders')
      .select('*')
      .eq('budget_order_id', budgetOrderId)
      .single()

    if (error || !data) return demoSettlementOrders.find(s => s.budget_order_id === budgetOrderId) || null
    return data as SettlementOrder
  } catch {
    return demoSettlementOrders.find(s => s.budget_order_id === budgetOrderId) || null
  }
}

// ============================================================
// 客户 & 产品
// ============================================================

export async function getCustomers(): Promise<Customer[]> {
  if (!isSupabaseConfigured()) return demoCustomers

  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .order('company')

    if (error || !data?.length) return demoCustomers
    return data as Customer[]
  } catch {
    return demoCustomers
  }
}

export async function getProducts(): Promise<Product[]> {
  if (!isSupabaseConfigured()) return demoProducts

  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('sku')

    if (error || !data?.length) return demoProducts
    return data as Product[]
  } catch {
    return demoProducts
  }
}

// ============================================================
// 预警 & 审批
// ============================================================

export async function getAlerts(): Promise<Alert[]> {
  if (!isSupabaseConfigured()) return demoAlerts

  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20)

    if (error || !data?.length) return demoAlerts
    return data as Alert[]
  } catch {
    return demoAlerts
  }
}

export async function getApprovalLogs(entityId: string): Promise<ApprovalLog[]> {
  if (!isSupabaseConfigured()) {
    return demoApprovalLogs.filter(l => l.entity_id === entityId)
  }

  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('approval_logs')
      .select('*, profiles:operator_id(*)')
      .eq('entity_id', entityId)
      .order('created_at', { ascending: true })

    if (error || !data?.length) return demoApprovalLogs.filter(l => l.entity_id === entityId)
    return data.map(log => ({
      ...log,
      operator: log.profiles ? { ...log.profiles, role: log.profiles.role || 'admin' } : undefined,
    })) as ApprovalLog[]
  } catch {
    return demoApprovalLogs.filter(l => l.entity_id === entityId)
  }
}

// ============================================================
// 仪表盘数据
// ============================================================

export async function getProfitSummary(): Promise<ProfitSummary> {
  if (!isSupabaseConfigured()) return demoProfitSummary

  try {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('budget_orders')
      .select('total_revenue, total_cost, estimated_profit, estimated_margin')
      .in('status', ['approved', 'closed'])

    if (error || !data?.length) return demoProfitSummary

    const totalRevenue = data.reduce((s, o) => s + (o.total_revenue || 0), 0)
    const totalCost = data.reduce((s, o) => s + (o.total_cost || 0), 0)
    const totalProfit = data.reduce((s, o) => s + (o.estimated_profit || 0), 0)
    const avgMargin = data.length > 0
      ? data.reduce((s, o) => s + (o.estimated_margin || 0), 0) / data.length
      : 0

    return {
      total_revenue: totalRevenue,
      total_cost: totalCost,
      total_profit: totalProfit,
      avg_margin: Math.round(avgMargin * 100) / 100,
      order_count: data.length,
      period: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }),
    }
  } catch {
    return demoProfitSummary
  }
}

export function getMonthlyProfitData() {
  // TODO: 从Supabase聚合月度数据
  return demoMonthlyProfit
}

// ============================================================
// 数据映射
// ============================================================

function mapDbBudgetOrder(row: Record<string, unknown>): BudgetOrder {
  const customer = row.customers as Record<string, unknown> | null
  return {
    id: row.id as string,
    order_no: row.order_no as string,
    customer_id: row.customer_id as string,
    customer: customer ? {
      id: customer.id as string,
      name: customer.name as string,
      company: customer.company as string,
      contact: (customer.contact as string) || null,
      email: (customer.email as string) || null,
      phone: (customer.phone as string) || null,
      country: (customer.country as string) || null,
      currency: (customer.currency as string) || 'USD',
      credit_limit: (customer.credit_limit as number) || null,
      notes: (customer.notes as string) || null,
      created_at: customer.created_at as string,
    } : undefined,
    order_date: row.order_date as string,
    delivery_date: (row.delivery_date as string) || null,
    items: (row.items as BudgetOrder['items']) || [],
    target_purchase_price: (row.target_purchase_price as number) || 0,
    estimated_freight: (row.estimated_freight as number) || 0,
    estimated_commission: (row.estimated_commission as number) || 0,
    estimated_customs_fee: (row.estimated_customs_fee as number) || 0,
    other_costs: (row.other_costs as number) || 0,
    total_revenue: (row.total_revenue as number) || 0,
    total_cost: (row.total_cost as number) || 0,
    estimated_profit: (row.estimated_profit as number) || 0,
    estimated_margin: (row.estimated_margin as number) || 0,
    currency: (row.currency as string) || 'USD',
    exchange_rate: (row.exchange_rate as number) || 1,
    status: row.status as BudgetOrderStatus,
    created_by: row.created_by as string,
    approved_by: (row.approved_by as string) || null,
    approved_at: (row.approved_at as string) || null,
    notes: (row.notes as string) || null,
    attachments: (row.attachments as string[]) || null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}
