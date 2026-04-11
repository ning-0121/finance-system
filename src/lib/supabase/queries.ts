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
    if (error) {
      console.error('getBudgetOrders DB error:', error.message)
      return demoBudgetOrders // DB错误时降级
    }
    if (!data || data.length === 0) return demoBudgetOrders // 空数据时用demo

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
        created_by: userData?.user?.id || (await supabase.from('profiles').select('id').limit(1).then(r => r.data?.[0]?.id)),
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

// 合法状态转换表（乐观锁：只有从正确的前置状态才能转）
const VALID_TRANSITIONS: Record<string, BudgetOrderStatus[]> = {
  draft: ['pending_review'],
  pending_review: ['approved', 'rejected', 'draft'], // draft=撤回
  approved: ['closed'],
  rejected: ['draft'], // 修改后重新提交
  closed: [],
}

export async function updateBudgetOrderStatus(
  id: string,
  newStatus: BudgetOrderStatus,
  approvedBy?: string
): Promise<{ error: string | null }> {
  if (!isSupabaseConfigured()) {
    return { error: null }
  }

  try {
    const supabase = createClient()

    // 1. 读取当前状态（乐观锁检查）
    const { data: current, error: readError } = await supabase
      .from('budget_orders')
      .select('status, updated_at')
      .eq('id', id)
      .single()

    if (readError || !current) {
      return { error: '订单不存在' }
    }

    // 2. 验证状态转换合法性
    const allowedTransitions = VALID_TRANSITIONS[current.status] || []
    if (!allowedTransitions.includes(newStatus)) {
      return { error: `不能从"${current.status}"转为"${newStatus}"` }
    }

    // 3. 带条件更新（乐观锁：只有状态没被他人改过才能更新）
    const updateData: Record<string, unknown> = { status: newStatus }
    if (newStatus === 'approved' && approvedBy) {
      updateData.approved_by = approvedBy
      updateData.approved_at = new Date().toISOString()
    }

    const { data: updated, error: updateError } = await supabase
      .from('budget_orders')
      .update(updateData)
      .eq('id', id)
      .eq('status', current.status) // 乐观锁：确保没被并发修改
      .select('id')

    if (updateError) return { error: updateError.message }
    if (!updated?.length) {
      return { error: '操作冲突：该订单已被其他人修改，请刷新后重试' }
    }

    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

export async function createApprovalLog(log: Partial<ApprovalLog>): Promise<{ error: string | null }> {
  if (!isSupabaseConfigured()) return { error: null }

  // 验证必填字段
  if (!log.entity_id || !log.action || !log.from_status || !log.to_status) {
    return { error: '审批记录缺少必填字段' }
  }

  // 验证 from_status !== to_status
  if (log.from_status === log.to_status) {
    return { error: '审批记录状态未变化' }
  }

  try {
    const supabase = createClient()
    const { error } = await supabase
      .from('approval_logs')
      .insert({
        entity_type: log.entity_type || 'budget_order',
        entity_id: log.entity_id,
        action: log.action,
        from_status: log.from_status,
        to_status: log.to_status,
        operator_id: log.operator_id || (await supabase.from('profiles').select('id').limit(1).then(r => r.data?.[0]?.id)),
        comment: log.comment ? String(log.comment).slice(0, 500) : null, // 限制长度
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
      .select('total_revenue, total_cost, estimated_profit, estimated_margin, currency, exchange_rate')
      .in('status', ['approved', 'closed'])

    if (error || !data?.length) return demoProfitSummary

    // 全部转CNY口径
    const totalRevenueCny = data.reduce((s, o) => {
      const rate = (o.currency as string) === 'CNY' ? 1 : ((o.exchange_rate as number) || 7)
      return s + (o.total_revenue || 0) * rate
    }, 0)
    const totalCost = data.reduce((s, o) => s + (o.total_cost || 0), 0) // 已经是CNY
    const totalProfit = totalRevenueCny - totalCost
    const avgMargin = totalRevenueCny > 0 ? totalProfit / totalRevenueCny * 100 : 0

    return {
      total_revenue: Math.round(totalRevenueCny),
      total_cost: Math.round(totalCost),
      total_profit: Math.round(totalProfit),
      avg_margin: Math.round(avgMargin * 100) / 100,
      order_count: data.length,
      period: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }),
    }
  } catch {
    return demoProfitSummary
  }
}

export async function getMonthlyProfitData() {
  if (!isSupabaseConfigured()) return demoMonthlyProfit
  try {
    const supabase = createClient()
    const { data: orders } = await supabase
      .from('budget_orders')
      .select('order_date, total_revenue, total_cost, estimated_profit, estimated_margin, currency, exchange_rate')
      .not('order_date', 'is', null)
      .order('order_date')
    if (!orders || orders.length === 0) return demoMonthlyProfit

    // 按月聚合（全部转CNY）
    const monthMap = new Map<string, { revenue: number; cost: number; profit: number; count: number }>()
    for (const o of orders) {
      const month = (o.order_date as string).substring(0, 7)
      const rate = (o.currency as string) === 'CNY' ? 1 : ((o.exchange_rate as number) || 7)
      const revCny = (o.total_revenue as number) * rate
      const costCny = o.total_cost as number
      const existing = monthMap.get(month) || { revenue: 0, cost: 0, profit: 0, count: 0 }
      existing.revenue += revCny
      existing.cost += costCny
      existing.profit += revCny - costCny
      existing.count += 1
      monthMap.set(month, existing)
    }

    const result = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6) // 最近6个月
      .map(([month, d]) => ({
        month,
        revenue: Math.round(d.revenue),
        cost: Math.round(d.cost),
        profit: Math.round(d.profit),
        margin: d.revenue > 0 ? Math.round(d.profit / d.revenue * 10000) / 100 : 0,
      }))

    return result.length > 0 ? result : demoMonthlyProfit
  } catch {
    return demoMonthlyProfit
  }
}

// ============================================================
// 风险事件 + 信任分值 + 待处理动作
// ============================================================

export async function getPendingRiskEvents(): Promise<Record<string, unknown>[]> {
  if (!isSupabaseConfigured()) return []
  try {
    const supabase = createClient()
    const { data } = await supabase
      .from('financial_risk_events')
      .select('*')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(20)
    return data || []
  } catch { return [] }
}

export async function getPendingDocumentActions(): Promise<Record<string, unknown>[]> {
  if (!isSupabaseConfigured()) return []
  try {
    const supabase = createClient()
    const { data } = await supabase
      .from('document_actions')
      .select('*, uploaded_documents(file_name, doc_category)')
      .eq('decision', 'pending')
      .order('created_at', { ascending: false })
      .limit(20)
    return data || []
  } catch { return [] }
}

export async function getTrustScoreSummary(): Promise<{
  distribution: Record<string, number>
  recentDegrades: Record<string, unknown>[]
}> {
  const defaultResult = { distribution: { T0: 0, T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 }, recentDegrades: [] }
  if (!isSupabaseConfigured()) return defaultResult
  try {
    const supabase = createClient()
    const { data: scores } = await supabase.from('automation_trust_scores').select('trust_level, subject_type, subject_id, trust_score')
    if (!scores?.length) return defaultResult

    const distribution: Record<string, number> = { T0: 0, T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 }
    for (const s of scores) {
      distribution[s.trust_level] = (distribution[s.trust_level] || 0) + 1
    }

    const recentDegrades = scores
      .filter(s => s.trust_score < 40)
      .sort((a, b) => a.trust_score - b.trust_score)
      .slice(0, 5)

    return { distribution, recentDegrades }
  } catch { return defaultResult }
}

export async function getHighRiskCustomers(): Promise<Record<string, unknown>[]> {
  if (!isSupabaseConfigured()) return []
  try {
    const supabase = createClient()
    const { data } = await supabase
      .from('customer_financial_profiles')
      .select('*')
      .in('risk_level', ['C', 'D', 'E'])
      .order('bad_debt_score', { ascending: false })
      .limit(10)
    return data || []
  } catch { return [] }
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
