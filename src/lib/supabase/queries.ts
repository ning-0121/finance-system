// ============================================================
// Supabase 数据服务层 — 所有数据库读写操作
// 带 demo data fallback：当Supabase未配置或查询为空时用演示数据
// ============================================================

import { createClient } from './client'
import { fetchAll } from './fetch-all'
import { bizToday } from '@/lib/biz-date'
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

/**
 * 取预算订单。
 *
 * 财务级安全策略（不再用 demo 数据掩盖真实状态）：
 *   - Supabase 未配置：返回 demoBudgetOrders（演示模式）
 *   - DB 报错：console.error 并返回 []。绝不能把"DB 故障"伪装成"业务有数据"，
 *     调用方看到空数组应当结合 toast/loading 状态自行提示
 *   - DB 返回空：返回 [] —— 真实空状态，不要替换成 demo
 */
export async function getBudgetOrders(statusFilter?: string): Promise<BudgetOrder[]> {
  if (!isSupabaseConfigured()) return demoBudgetOrders

  try {
    const supabase = createClient()
    // 分页取全量（服务端 max-rows 默认 1000，.limit(2000) 也会被截断）；排除软删订单
    const { data, error } = await fetchAll<Record<string, unknown>>((from, to) => {
      // 列表不取 items 大 jsonb（_cost_breakdown 全部明细）——那是全表拉取卡死主线程的元凶；
      // 需要 items 的走 getBudgetOrderById（单条全量）。其余标量字段一个不落，功能不变。
      let query = supabase
        .from('budget_orders')
        .select('id, order_no, customer_id, order_date, delivery_date, target_purchase_price, estimated_freight, estimated_commission, estimated_customs_fee, other_costs, total_revenue, total_cost, estimated_profit, estimated_margin, currency, exchange_rate, version, status, created_by, approved_by, approved_at, notes, attachments, ar_received_amount, ar_received_at, ar_received_bank, created_at, updated_at, customers(*)')
        .is('deleted_at', null)
        .order('created_at', { ascending: false }).order('id', { ascending: true })
      if (statusFilter && statusFilter !== 'all') {
        query = query.eq('status', statusFilter)
      }
      return query.range(from, to)
    })
    if (error) {
      console.error('[getBudgetOrders] DB error:', error.message)
      return [] // 真实失败：返回空，不返回 demo
    }
    return (data || []).map(mapDbBudgetOrder)
  } catch (e) {
    console.error('[getBudgetOrders] unexpected error:', e)
    return []
  }
}

// 轻量订单列表（仅列表/看板展示需要的字段，不含 items 大 jsonb 与整表客户 join）。
// 工作台/概览等"只展示不编辑"的页面用它，避免拉全表大字段卡死主线程。
export interface BudgetOrderLite {
  id: string
  order_no: string
  status: string
  currency: string
  total_revenue: number
  total_cost: number
  estimated_profit: number
  estimated_margin: number
  customer: { company: string } | null
}
export async function getBudgetOrdersLite(): Promise<BudgetOrderLite[]> {
  if (!isSupabaseConfigured()) return demoBudgetOrders.map(o => ({
    id: o.id, order_no: o.order_no, status: o.status, currency: o.currency,
    total_revenue: o.total_revenue, total_cost: o.total_cost, estimated_profit: o.estimated_profit,
    estimated_margin: o.estimated_margin, customer: o.customer ? { company: o.customer.company } : null,
  }))
  try {
    const supabase = createClient()
    const { data, error } = await fetchAll<Record<string, unknown>>((from, to) => supabase
      .from('budget_orders')
      .select('id, order_no, status, currency, total_revenue, total_cost, estimated_profit, estimated_margin, customers(company)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }).order('id', { ascending: true })
      .range(from, to))
    if (error) { console.error('[getBudgetOrdersLite]', error.message); return [] }
    return (data || []).map(r => ({
      id: r.id as string,
      order_no: (r.order_no as string) || '',
      status: (r.status as string) || '',
      currency: (r.currency as string) || 'CNY',
      total_revenue: Number(r.total_revenue) || 0,
      total_cost: Number(r.total_cost) || 0,
      estimated_profit: Number(r.estimated_profit) || 0,
      estimated_margin: Number(r.estimated_margin) || 0,
      customer: (r.customers as { company?: string } | null)?.company ? { company: (r.customers as { company: string }).company } : null,
    }))
  } catch (e) { console.error('[getBudgetOrdersLite]', e); return [] }
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

    if (error) {
      console.error('[getBudgetOrderById] DB error:', error.message)
      return null  // 不再回 demo：DB 错时 UI 显示"订单不存在"比假数据安全
    }
    if (!data) return null
    return mapDbBudgetOrder(data)
  } catch (e) {
    console.error('[getBudgetOrderById] unexpected error:', e)
    return null
  }
}

export async function createBudgetOrder(order: Partial<BudgetOrder>): Promise<{ data: BudgetOrder | null; error: string | null }> {
  if (!isSupabaseConfigured()) {
    return { data: null, error: 'Supabase not configured (demo mode)' }
  }

  try {
    const supabase = createClient()
    // created_by 必须是真实登录人，不回退"第一个 profile"（防审计归属伪造）
    const { data: userData } = await supabase.auth.getUser()
    if (!userData?.user?.id) return { data: null, error: '登录态已失效，请重新登录后再创建订单' }

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
        created_by: userData.user.id,
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
        operator_id: log.operator_id || (await supabase.auth.getUser()).data.user?.id || null,
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

    if (error) {
      console.error('[getSettlementByBudgetId] DB error:', error.message)
      return null
    }
    if (!data) return null
    return data as SettlementOrder
  } catch (e) {
    console.error('[getSettlementByBudgetId] unexpected error:', e)
    return null
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

    if (error) {
      console.error('[getCustomers] DB error:', error.message)
      return []
    }
    return (data || []) as Customer[]
  } catch (e) {
    console.error('[getCustomers] unexpected error:', e)
    return []
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

    if (error) {
      console.error('[getProducts] DB error:', error.message)
      return []
    }
    return (data || []) as Product[]
  } catch (e) {
    console.error('[getProducts] unexpected error:', e)
    return []
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

    if (error) {
      console.error('[getAlerts] DB error:', error.message)
      return []
    }
    return (data || []) as Alert[]
  } catch (e) {
    console.error('[getAlerts] unexpected error:', e)
    return []
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

    if (error) {
      console.error('[getApprovalLogs] DB error:', error.message)
      return []
    }
    return (data || []).map(log => ({
      ...log,
      operator: log.profiles ? { ...log.profiles, role: log.profiles.role || 'admin' } : undefined,
    })) as ApprovalLog[]
  } catch (e) {
    console.error('[getApprovalLogs] unexpected error:', e)
    return []
  }
}

// ============================================================
// 仪表盘数据
// ============================================================

export async function getProfitSummary(): Promise<ProfitSummary> {
  if (!isSupabaseConfigured()) return demoProfitSummary

  try {
    const supabase = createClient()
    const { data, error } = await fetchAll<Record<string, unknown>>((from, to) => supabase
      .from('budget_orders')
      .select('total_revenue, total_cost, estimated_profit, estimated_margin, currency, exchange_rate')
      .in('status', ['approved', 'closed']).is('deleted_at', null)
      .order('id', { ascending: true }).range(from, to))

    if (error) {
      console.error('[getProfitSummary] DB error:', error.message)
      return { total_revenue: 0, total_cost: 0, total_profit: 0, avg_margin: 0, order_count: 0, period: '' }
    }
    if (!data?.length) {
      // 真实空：返回零值而非 demo
      return { total_revenue: 0, total_cost: 0, total_profit: 0, avg_margin: 0, order_count: 0, period: new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' }) }
    }

    // 全部转CNY口径
    const totalRevenueCny = data.reduce((s, o) => {
      const rate = (o.currency as string) === 'CNY' ? 1 : (Number(o.exchange_rate) || 7)
      return s + (Number(o.total_revenue) || 0) * rate
    }, 0)
    const totalCost = data.reduce((s, o) => s + (Number(o.total_cost) || 0), 0) // 已经是CNY
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
  } catch (e) {
    console.error('[getProfitSummary] unexpected error:', e)
    return { total_revenue: 0, total_cost: 0, total_profit: 0, avg_margin: 0, order_count: 0, period: '' }
  }
}

export async function getMonthlyProfitData() {
  if (!isSupabaseConfigured()) return demoMonthlyProfit
  try {
    const supabase = createClient()
    // 与控制中心 KPI(getProfitSummary)同口径：仅已审批/已关闭、排除软删；分页取全量
    const { data: orders } = await fetchAll<Record<string, unknown>>((from, to) => supabase
      .from('budget_orders')
      .select('order_date, total_revenue, total_cost, estimated_profit, estimated_margin, currency, exchange_rate')
      .not('order_date', 'is', null).is('deleted_at', null).in('status', ['approved', 'closed'])
      .order('order_date').order('id', { ascending: true }).range(from, to))
    if (!orders || orders.length === 0) return []

    // 按月聚合（全部转CNY）
    const monthMap = new Map<string, { revenue: number; cost: number; profit: number; count: number }>()
    for (const o of orders) {
      const month = (o.order_date as string).substring(0, 7)
      const rate = (o.currency as string) === 'CNY' ? 1 : ((o.exchange_rate as number) ?? 7)
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

    return result
  } catch (e) {
    console.error('[getMonthlyProfitData] unexpected error:', e)
    return []
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
    version: (row.version as number) || 1,
    status: row.status as BudgetOrderStatus,
    created_by: row.created_by as string,
    approved_by: (row.approved_by as string) || null,
    approved_at: (row.approved_at as string) || null,
    notes: (row.notes as string) || null,
    attachments: (row.attachments as string[]) || null,
    ar_received_amount: row.ar_received_amount != null ? Number(row.ar_received_amount) : null,
    ar_received_at: (row.ar_received_at as string) || null,
    ar_received_bank: (row.ar_received_bank as string) || null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

/**
 * 核销应收余额 — 财务化（决议④A）：不再直写 ar_received_amount（旧实现对已有
 * 匹配流水的订单会被 projection 刷新覆盖、且不可追溯）。改为：
 *   生成一条「核销调整」回款流水 + 匹配到本订单（RPC 回写 projection），
 *   可在回款流水中撤销匹配/作废回退。订单 notes 仍追加核销原因。
 * 金额口径：有流水 → 核销剩余 = 合同CNY − 已匹配CNY；
 *           无流水的历史订单 → 把历史已收与核销尾差合并为一条流水（金额=合同CNY）。
 */
export async function writeOffReceivable(
  id: string,
  _totalRevenue: number,
  reason: string
): Promise<{ error: string | null }> {
  if (!isSupabaseConfigured()) {
    return { error: '当前为演示模式或未连接数据库，无法保存' }
  }
  try {
    const supabase = createClient()
    const { data: order } = await supabase
      .from('budget_orders')
      .select('id, total_revenue, currency, exchange_rate, notes, customers(company)')
      .eq('id', id)
      .maybeSingle()
    if (!order) return { error: '订单不存在' }
    const r2 = (n: number) => Math.round(n * 100) / 100
    const rate = order.currency === 'CNY' ? 1 : (Number(order.exchange_rate) || 1)
    const contractCny = r2((Number(order.total_revenue) || 0) * rate)

    // 权威已收 = 未作废分配合计
    const { data: allocs } = await supabase
      .from('receivable_payment_allocations')
      .select('amount_cny')
      .eq('budget_order_id', id)
      .is('voided_at', null)
    const hasLedger = (allocs || []).length > 0
    const allocCny = r2((allocs || []).reduce((s, a) => s + (Number(a.amount_cny) || 0), 0))
    const writeOffCny = hasLedger ? r2(contractCny - allocCny) : contractCny
    if (writeOffCny <= 0.005) return { error: '该订单按回款流水口径已无应收余额，无需核销' }

    // 1) 生成核销调整流水（CNY 口径，可追溯、可作废）
    const { createReceivablePayment, allocateReceipt } = await import('./queries-v2')
    const customerName = (order.customers as unknown as { company?: string } | null)?.company || null
    const { data: pay, error: payErr } = await createReceivablePayment({
      customer_name: customerName,
      budget_order_id: id,
      amount_original: writeOffCny,
      currency: 'CNY',
      exchange_rate: 1,
      received_at: new Date().toISOString(),
      source_type: 'manual',
      notes: `[核销调整] ${reason}${hasLedger ? '' : '（含历史已收合并入流水）'} — 由核销操作生成，可撤销匹配回退`,
    })
    if (payErr || !pay) return { error: `生成核销流水失败：${payErr || '未知错误'}` }

    // 2) 匹配到订单（RPC 事务：防超分配 + 自动状态 + 回写 projection + 时间线）
    const { error: allocErr } = await allocateReceipt({ receipt_id: pay.id, budget_order_id: id, amount_cny: writeOffCny })
    if (allocErr) return { error: `核销流水已生成但匹配失败：${allocErr}。请到回款流水手动匹配或作废该笔` }

    // 3) 订单 notes 追加核销原因（保留原审计习惯）
    const existingNotes = (order.notes as string) || ''
    const today = bizToday()
    const newNote = `[核销 ${today}] ${reason}`
    const mergedNotes = existingNotes ? `${existingNotes}\n${newNote}` : newNote
    await supabase
      .from('budget_orders')
      .update({ ar_received_at: new Date().toISOString(), notes: mergedNotes, updated_at: new Date().toISOString() })
      .eq('id', id)

    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}

/**
 * 修正订单应收金额（total_revenue）— 用于应收页面数据纠错。
 * 同时在 notes 中追加修改记录。
 */
export async function correctOrderRevenue(
  id: string,
  newRevenue: number,
  reason: string
): Promise<{ error: string | null }> {
  if (!isSupabaseConfigured()) {
    return { error: '当前为演示模式或未连接数据库，无法保存' }
  }
  try {
    const supabase = createClient()
    const { data: row } = await supabase
      .from('budget_orders')
      .select('notes, total_revenue')
      .eq('id', id)
      .maybeSingle()
    const existingNotes = (row?.notes as string) || ''
    const oldRevenue = row?.total_revenue as number ?? 0
    const today = new Date().toISOString().substring(0, 10)
    const newNote = `[金额修正 ${today}] ${oldRevenue} → ${newRevenue}，原因: ${reason}`
    const mergedNotes = existingNotes ? `${existingNotes}\n${newNote}` : newNote

    const { error } = await supabase
      .from('budget_orders')
      .update({
        total_revenue: newRevenue,
        notes: mergedNotes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (error) return { error: error.message }
    return { error: null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Unknown error' }
  }
}
