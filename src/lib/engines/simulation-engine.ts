// ============================================================
// Simulation Engine — What-if Analysis (Read-only)
// ============================================================
// Runs hypothetical scenarios against live data without writing
// to any business tables. Only simulation_scenarios is written to
// when the user explicitly saves a scenario.

import { createClient } from '@/lib/supabase/client'

// --------------- Types ---------------

export interface SimulationResult {
  baseRevenue: number
  simulatedRevenue: number
  revenueChange: number
  baseProfit: number
  simulatedProfit: number
  profitChange: number
  baseMargin: number
  simulatedMargin: number
  affectedOrders: {
    orderNo: string
    customer: string
    currentProfit: number
    simulatedProfit: number
  }[]
  riskFlags: string[]
  summary: string
}

interface OrderRow {
  id: string
  order_no: string
  customer_id: string
  total_revenue: number
  total_cost: number
  estimated_profit: number
  estimated_margin: number
  currency: string
  exchange_rate: number
  target_purchase_price: number
  estimated_freight: number
  estimated_commission: number
  estimated_customs_fee: number
  other_costs: number
  status: string
}

// --------------- Helpers ---------------

async function loadActiveOrders(): Promise<OrderRow[]> {
  const supabase = createClient()
  const { data } = await supabase
    .from('budget_orders')
    .select(
      'id, order_no, customer_id, total_revenue, total_cost, estimated_profit, estimated_margin, currency, exchange_rate, target_purchase_price, estimated_freight, estimated_commission, estimated_customs_fee, other_costs, status'
    )
    .in('status', ['approved', 'closed'])

  return (data || []) as unknown as OrderRow[]
}

async function loadCustomerMap(): Promise<Map<string, string>> {
  const supabase = createClient()
  const { data } = await supabase.from('customers').select('id, company')
  return new Map((data || []).map((c) => [c.id as string, c.company as string]))
}

function computeBaseMetrics(orders: OrderRow[]) {
  const baseRevenue = orders.reduce((s, o) => {
    const rate = o.currency === 'CNY' ? 1 : (o.exchange_rate || 7)
    return s + o.total_revenue * rate
  }, 0)

  const baseCost = orders.reduce((s, o) => s + o.total_cost, 0)
  const baseProfit = baseRevenue - baseCost
  const baseMargin = baseRevenue > 0 ? (baseProfit / baseRevenue) * 100 : 0

  return { baseRevenue, baseCost, baseProfit, baseMargin }
}

// --------------- Public API ---------------

/**
 * Simulate FX rate change for all USD orders.
 * Recalculates CNY revenue at the new rate, compares with budget rate.
 */
export async function simulateFxChange(newRate: number): Promise<SimulationResult> {
  const orders = await loadActiveOrders()
  const customerMap = await loadCustomerMap()

  const usdOrders = orders.filter((o) => o.currency === 'USD')
  const cnyOrders = orders.filter((o) => o.currency === 'CNY')

  // Base metrics (all orders in CNY)
  const { baseRevenue, baseCost, baseProfit, baseMargin } = computeBaseMetrics(orders)

  // Simulated: USD orders use new rate, CNY orders stay the same
  const simUsdRevenue = usdOrders.reduce((s, o) => s + o.total_revenue * newRate, 0)
  const simCnyRevenue = cnyOrders.reduce((s, o) => s + o.total_revenue, 0)
  const simulatedRevenue = simUsdRevenue + simCnyRevenue

  // Costs remain in CNY, unchanged
  const simulatedProfit = simulatedRevenue - baseCost
  const simulatedMargin = simulatedRevenue > 0 ? (simulatedProfit / simulatedRevenue) * 100 : 0

  const affectedOrders = usdOrders.map((o) => {
    const currentRevenueCny = o.total_revenue * (o.exchange_rate || 7)
    const simRevenueCny = o.total_revenue * newRate
    const currentProfit = currentRevenueCny - o.total_cost
    const simulatedOrderProfit = simRevenueCny - o.total_cost

    return {
      orderNo: o.order_no,
      customer: customerMap.get(o.customer_id) || '未知客户',
      currentProfit: Math.round(currentProfit * 100) / 100,
      simulatedProfit: Math.round(simulatedOrderProfit * 100) / 100,
    }
  })

  const riskFlags: string[] = []
  const lossOrders = affectedOrders.filter((o) => o.simulatedProfit < 0)
  if (lossOrders.length > 0) {
    riskFlags.push(`${lossOrders.length}笔订单将出现亏损`)
  }
  if (simulatedMargin < 5) {
    riskFlags.push(`整体利润率将降至${simulatedMargin.toFixed(1)}%, 低于安全线`)
  }
  const revenueChange = simulatedRevenue - baseRevenue
  if (Math.abs(revenueChange) / baseRevenue > 0.1) {
    riskFlags.push(`收入变动超过10%`)
  }

  const direction = newRate > (usdOrders[0]?.exchange_rate || 7) ? '升值' : '贬值'

  return {
    baseRevenue: Math.round(baseRevenue * 100) / 100,
    simulatedRevenue: Math.round(simulatedRevenue * 100) / 100,
    revenueChange: Math.round(revenueChange * 100) / 100,
    baseProfit: Math.round(baseProfit * 100) / 100,
    simulatedProfit: Math.round(simulatedProfit * 100) / 100,
    profitChange: Math.round((simulatedProfit - baseProfit) * 100) / 100,
    baseMargin: Math.round(baseMargin * 10) / 10,
    simulatedMargin: Math.round(simulatedMargin * 10) / 10,
    affectedOrders,
    riskFlags,
    summary: `汇率从${usdOrders[0]?.exchange_rate || 7}${direction}至${newRate}: 影响${usdOrders.length}笔USD订单, 利润变动¥${Math.round(simulatedProfit - baseProfit)}`,
  }
}

/**
 * Simulate cost increase on a specific cost component.
 * costType: 'purchase' | 'freight' | 'commission' | 'customs' | 'other'
 */
export async function simulateCostIncrease(
  costType: string,
  increasePercent: number
): Promise<SimulationResult> {
  const orders = await loadActiveOrders()
  const customerMap = await loadCustomerMap()

  const { baseRevenue, baseCost, baseProfit, baseMargin } = computeBaseMetrics(orders)

  const multiplier = 1 + increasePercent / 100

  const affectedOrders = orders.map((o) => {
    const rate = o.currency === 'CNY' ? 1 : (o.exchange_rate || 7)
    const revenueCny = o.total_revenue * rate

    let costDelta = 0
    switch (costType) {
      case 'purchase':
        costDelta = o.target_purchase_price * (multiplier - 1)
        break
      case 'freight':
        costDelta = o.estimated_freight * (multiplier - 1)
        break
      case 'commission':
        costDelta = o.estimated_commission * (multiplier - 1)
        break
      case 'customs':
        costDelta = o.estimated_customs_fee * (multiplier - 1)
        break
      case 'other':
        costDelta = o.other_costs * (multiplier - 1)
        break
      default:
        // Apply to total cost proportionally
        costDelta = o.total_cost * (multiplier - 1)
    }

    const currentProfit = revenueCny - o.total_cost
    const simulatedProfit = revenueCny - (o.total_cost + costDelta)

    return {
      orderNo: o.order_no,
      customer: customerMap.get(o.customer_id) || '未知客户',
      currentProfit: Math.round(currentProfit * 100) / 100,
      simulatedProfit: Math.round(simulatedProfit * 100) / 100,
      costDelta,
    }
  })

  const totalCostDelta = affectedOrders.reduce((s, o) => s + o.costDelta, 0)
  const simulatedProfit = baseProfit - totalCostDelta
  const simulatedMargin = baseRevenue > 0 ? (simulatedProfit / baseRevenue) * 100 : 0

  const riskFlags: string[] = []
  const lossOrders = affectedOrders.filter((o) => o.simulatedProfit < 0)
  if (lossOrders.length > 0) {
    riskFlags.push(`${lossOrders.length}笔订单将出现亏损`)
  }
  if (simulatedMargin < 5) {
    riskFlags.push(`整体利润率将降至${simulatedMargin.toFixed(1)}%, 低于安全线`)
  }
  if (totalCostDelta > baseProfit * 0.5) {
    riskFlags.push(`成本增幅将吞噬超过50%的利润`)
  }

  const costTypeLabels: Record<string, string> = {
    purchase: '采购成本',
    freight: '运费',
    commission: '佣金',
    customs: '关税',
    other: '其他费用',
  }

  return {
    baseRevenue: Math.round(baseRevenue * 100) / 100,
    simulatedRevenue: Math.round(baseRevenue * 100) / 100, // Revenue unchanged
    revenueChange: 0,
    baseProfit: Math.round(baseProfit * 100) / 100,
    simulatedProfit: Math.round(simulatedProfit * 100) / 100,
    profitChange: Math.round(-totalCostDelta * 100) / 100,
    baseMargin: Math.round(baseMargin * 10) / 10,
    simulatedMargin: Math.round(simulatedMargin * 10) / 10,
    affectedOrders: affectedOrders.map(({ costDelta: _, ...rest }) => rest),
    riskFlags,
    summary: `${costTypeLabels[costType] || costType}上涨${increasePercent}%: 影响${orders.length}笔订单, 利润减少¥${Math.round(totalCostDelta)}`,
  }
}

/**
 * Simulate losing a customer — remove their orders from totals.
 */
export async function simulateCustomerLoss(customerId: string): Promise<SimulationResult> {
  const orders = await loadActiveOrders()
  const customerMap = await loadCustomerMap()

  const { baseRevenue, baseCost, baseProfit, baseMargin } = computeBaseMetrics(orders)

  const lostOrders = orders.filter((o) => o.customer_id === customerId)
  const remainingOrders = orders.filter((o) => o.customer_id !== customerId)

  if (lostOrders.length === 0) {
    return {
      baseRevenue: Math.round(baseRevenue * 100) / 100,
      simulatedRevenue: Math.round(baseRevenue * 100) / 100,
      revenueChange: 0,
      baseProfit: Math.round(baseProfit * 100) / 100,
      simulatedProfit: Math.round(baseProfit * 100) / 100,
      profitChange: 0,
      baseMargin: Math.round(baseMargin * 10) / 10,
      simulatedMargin: Math.round(baseMargin * 10) / 10,
      affectedOrders: [],
      riskFlags: [],
      summary: '该客户没有活跃订单, 无影响',
    }
  }

  const lostRevenue = lostOrders.reduce((s, o) => {
    const rate = o.currency === 'CNY' ? 1 : (o.exchange_rate || 7)
    return s + o.total_revenue * rate
  }, 0)
  const lostCost = lostOrders.reduce((s, o) => s + o.total_cost, 0)
  const lostProfit = lostRevenue - lostCost

  const simulatedRevenue = baseRevenue - lostRevenue
  const simulatedProfit = baseProfit - lostProfit
  const simulatedMargin = simulatedRevenue > 0 ? (simulatedProfit / simulatedRevenue) * 100 : 0

  const customerName = customerMap.get(customerId) || '未知客户'

  const affectedOrders = lostOrders.map((o) => {
    const rate = o.currency === 'CNY' ? 1 : (o.exchange_rate || 7)
    const revenueCny = o.total_revenue * rate
    const profit = revenueCny - o.total_cost
    return {
      orderNo: o.order_no,
      customer: customerName,
      currentProfit: Math.round(profit * 100) / 100,
      simulatedProfit: 0, // order removed entirely
    }
  })

  const riskFlags: string[] = []
  const revenueSharePct = (lostRevenue / baseRevenue) * 100
  if (revenueSharePct > 20) {
    riskFlags.push(`该客户贡献${revenueSharePct.toFixed(1)}%的收入, 客户集中度风险高`)
  }
  if (simulatedMargin < 5) {
    riskFlags.push(`失去该客户后整体利润率降至${simulatedMargin.toFixed(1)}%`)
  }
  if (remainingOrders.length === 0) {
    riskFlags.push('失去该客户后将没有活跃订单')
  }

  return {
    baseRevenue: Math.round(baseRevenue * 100) / 100,
    simulatedRevenue: Math.round(simulatedRevenue * 100) / 100,
    revenueChange: Math.round(-lostRevenue * 100) / 100,
    baseProfit: Math.round(baseProfit * 100) / 100,
    simulatedProfit: Math.round(simulatedProfit * 100) / 100,
    profitChange: Math.round(-lostProfit * 100) / 100,
    baseMargin: Math.round(baseMargin * 10) / 10,
    simulatedMargin: Math.round(simulatedMargin * 10) / 10,
    affectedOrders,
    riskFlags,
    summary: `失去客户"${customerName}": 涉及${lostOrders.length}笔订单, 收入减少¥${Math.round(lostRevenue)}, 利润减少¥${Math.round(lostProfit)}`,
  }
}

/**
 * Simulate a supply disruption for a specific supplier.
 * Finds all orders that reference this supplier in sub-documents and marks as at-risk.
 */
export async function simulateSupplyDisruption(supplierName: string): Promise<SimulationResult> {
  const supabase = createClient()
  const orders = await loadActiveOrders()
  const customerMap = await loadCustomerMap()

  const { baseRevenue, baseCost, baseProfit, baseMargin } = computeBaseMetrics(orders)

  // Find sub-documents referencing this supplier
  const { data: subDocs } = await supabase
    .from('sub_documents')
    .select('id, budget_order_id, doc_type, estimated_total, supplier_name')
    .ilike('supplier_name', `%${supplierName}%`)

  const affectedBudgetIds = new Set(
    (subDocs || []).map((d) => d.budget_order_id as string)
  )

  // Also check payable_records for this supplier
  const { data: payables } = await supabase
    .from('payable_records')
    .select('budget_order_id, supplier_name, amount')
    .ilike('supplier_name', `%${supplierName}%`)

  for (const p of payables || []) {
    if (p.budget_order_id) affectedBudgetIds.add(p.budget_order_id as string)
  }

  const affectedOrders = orders
    .filter((o) => affectedBudgetIds.has(o.id))
    .map((o) => {
      const rate = o.currency === 'CNY' ? 1 : (o.exchange_rate || 7)
      const revenueCny = o.total_revenue * rate
      const profit = revenueCny - o.total_cost

      return {
        orderNo: o.order_no,
        customer: customerMap.get(o.customer_id) || '未知客户',
        currentProfit: Math.round(profit * 100) / 100,
        simulatedProfit: 0, // Assume full disruption = order at risk
      }
    })

  // Calculate impact assuming all affected orders may be delayed/lost
  const atRiskRevenue = orders
    .filter((o) => affectedBudgetIds.has(o.id))
    .reduce((s, o) => {
      const rate = o.currency === 'CNY' ? 1 : (o.exchange_rate || 7)
      return s + o.total_revenue * rate
    }, 0)

  const atRiskCost = orders
    .filter((o) => affectedBudgetIds.has(o.id))
    .reduce((s, o) => s + o.total_cost, 0)

  const atRiskProfit = atRiskRevenue - atRiskCost

  // Worst case: all at-risk orders lost
  const simulatedRevenue = baseRevenue - atRiskRevenue
  const simulatedProfit = baseProfit - atRiskProfit
  const simulatedMargin = simulatedRevenue > 0 ? (simulatedProfit / simulatedRevenue) * 100 : 0

  const riskFlags: string[] = []
  if (affectedOrders.length === 0) {
    riskFlags.push('未找到与该供应商相关的订单')
  } else {
    riskFlags.push(`${affectedOrders.length}笔订单依赖供应商"${supplierName}"`)
    const supplierCost = (subDocs || []).reduce(
      (s, d) => s + ((d.estimated_total as number) || 0),
      0
    )
    if (supplierCost > 0) {
      riskFlags.push(`涉及供应金额约¥${Math.round(supplierCost)}`)
    }
    if (atRiskRevenue / baseRevenue > 0.3) {
      riskFlags.push(`受影响收入占总收入${((atRiskRevenue / baseRevenue) * 100).toFixed(1)}%, 供应链集中度过高`)
    }
  }

  return {
    baseRevenue: Math.round(baseRevenue * 100) / 100,
    simulatedRevenue: Math.round(simulatedRevenue * 100) / 100,
    revenueChange: Math.round(-atRiskRevenue * 100) / 100,
    baseProfit: Math.round(baseProfit * 100) / 100,
    simulatedProfit: Math.round(simulatedProfit * 100) / 100,
    profitChange: Math.round(-atRiskProfit * 100) / 100,
    baseMargin: Math.round(baseMargin * 10) / 10,
    simulatedMargin: Math.round(simulatedMargin * 10) / 10,
    affectedOrders,
    riskFlags,
    summary: `供应商"${supplierName}"中断: ${affectedOrders.length}笔订单受影响, 最大风险敞口¥${Math.round(atRiskRevenue)}`,
  }
}

/**
 * Save a simulation scenario for later review. This is the only write operation.
 */
export async function saveScenario(
  name: string,
  type: string,
  params: Record<string, unknown>,
  result: SimulationResult,
  createdBy: string
): Promise<string> {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('simulation_scenarios')
    .insert({
      name,
      scenario_type: type,
      parameters: params,
      base_snapshot: {
        revenue: result.baseRevenue,
        profit: result.baseProfit,
        margin: result.baseMargin,
      },
      simulated_result: {
        revenue: result.simulatedRevenue,
        profit: result.simulatedProfit,
        margin: result.simulatedMargin,
        affectedOrders: result.affectedOrders.length,
        riskFlags: result.riskFlags,
      },
      impact_summary: result.summary,
      created_by: createdBy,
    })
    .select('id')
    .single()

  if (error) throw new Error(`保存模拟场景失败: ${error.message}`)
  return data.id as string
}

/**
 * Get all saved simulation scenarios.
 */
export async function getSavedScenarios(): Promise<Record<string, unknown>[]> {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('simulation_scenarios')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw new Error(`查询模拟场景失败: ${error.message}`)
  return (data || []) as Record<string, unknown>[]
}
