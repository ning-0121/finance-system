/**
 * 客户财务档案聚合(2026-08-04)
 *
 * 一个客户在某周期内的:订单个数、订单总件数、订单总额、总成本、总利润、平均利润率。
 *
 * 三条口径纪律(都踩过坑,写在这里免得下次又走偏):
 *  ① 只计【已通过/已关闭】—— 草稿与驳回单不进客户业绩(审计 P2:此前虚增客户收入)。
 *  ② 收入必须先按订单自身汇率折 CNY 再相加 —— 不同订单汇率不同,直接加原币是错的;
 *     利润 = 收入CNY − 成本(total_cost 全站约定已是 CNY)。
 *  ③ 外币缺汇率【不按 1:1、也不按写死的 7 硬算】—— 单列为"缺汇率"不计入合计,
 *     并在 UI 上明示有几单没算进去。此前本页用 `o.exchange_rate || 7`,
 *     等于拿一个猜的汇率去算客户业绩,数字看着有、其实不可信。
 */
import { computeOrderProfit } from './order-profit'
import { inPeriod, isAllTime, type PeriodRange } from './period'

export interface CustomerOrderRow {
  id: string
  orderNo: string
  internalNo?: string | null
  orderDate: string | null
  currency: string
  exchangeRate: number | null
  /** 原币合同金额 */
  revenueOriginal: number
  revenueCny: number
  costCny: number
  profitCny: number
  marginPct: number
  quantity: number
  status: string
  /** 外币缺汇率:该单不计入合计 */
  missingRate: boolean
}

export interface CustomerSummary {
  name: string
  country: string
  orderCount: number
  totalQuantity: number
  totalRevenueCny: number
  totalCostCny: number
  totalProfitCny: number
  /** 平均利润率 = 总利润 ÷ 总收入(加权),不是各单利润率的算术平均 */
  avgMarginPct: number
  /** 因缺汇率未计入合计的订单数 —— 必须让用户看见,否则合计"看着对其实少" */
  excludedMissingRate: number
  orders: CustomerOrderRow[]
}

const num = (v: unknown) => Number(v) || 0
const r2 = (v: number) => Math.round(v * 100) / 100

export interface RawOrder {
  id: string
  order_no?: string | null
  internal_order_no?: string | null
  order_date?: string | null
  status?: string | null
  currency?: string | null
  exchange_rate?: number | string | null
  total_revenue?: number | string | null
  total_cost?: number | string | null
  customer?: { company?: string | null; country?: string | null } | null
}

/** 计入客户业绩的订单状态 */
export const COUNTED_STATUSES = ['approved', 'closed'] as const
export const isCounted = (s?: string | null) => (COUNTED_STATUSES as readonly string[]).includes(String(s || ''))

/**
 * 按客户聚合。
 * @param quantityOf 订单件数取数器 —— 件数在 synced_orders.quantity 上,
 *                   budget_orders 里没有,故由调用方注入(避免本模块耦合数据源)。
 */
export function summarizeCustomers(
  orders: RawOrder[],
  period: PeriodRange,
  quantityOf: (orderId: string) => number = () => 0,
): CustomerSummary[] {
  const map = new Map<string, CustomerSummary>()

  for (const o of orders) {
    if (!isCounted(o.status)) continue
    if (!isAllTime(period) && !inPeriod(o.order_date, period)) continue

    const name = o.customer?.company?.trim() || '未知客户'
    let c = map.get(name)
    if (!c) {
      c = {
        name, country: o.customer?.country || '',
        orderCount: 0, totalQuantity: 0, totalRevenueCny: 0, totalCostCny: 0,
        totalProfitCny: 0, avgMarginPct: 0, excludedMissingRate: 0, orders: [],
      }
      map.set(name, c)
    }

    const calc = computeOrderProfit(o)
    const missingRate = !calc.usable && calc.reason === 'missing_rate'
    const qty = num(quantityOf(o.id))

    c.orders.push({
      id: o.id,
      orderNo: o.order_no || '',
      internalNo: o.internal_order_no ?? null,
      orderDate: o.order_date ?? null,
      currency: String(o.currency || 'CNY').toUpperCase(),
      exchangeRate: o.exchange_rate != null ? num(o.exchange_rate) : null,
      revenueOriginal: r2(num(o.total_revenue)),
      revenueCny: missingRate ? 0 : calc.revenueCny,
      costCny: r2(num(o.total_cost)),
      profitCny: missingRate ? 0 : calc.profitCny,
      marginPct: missingRate ? 0 : calc.marginPct,
      quantity: qty,
      status: String(o.status || ''),
      missingRate,
    })

    c.orderCount += 1
    c.totalQuantity += qty
    if (missingRate) {
      c.excludedMissingRate += 1      // 件数仍计(件数与汇率无关),金额不计
      continue
    }
    c.totalRevenueCny += calc.revenueCny
    c.totalCostCny += r2(num(o.total_cost))
    c.totalProfitCny += calc.profitCny
  }

  const out = [...map.values()]
  for (const c of out) {
    c.totalRevenueCny = r2(c.totalRevenueCny)
    c.totalCostCny = r2(c.totalCostCny)
    c.totalProfitCny = r2(c.totalProfitCny)
    // 加权平均:总利润 ÷ 总收入。用各单利润率求算术平均会被小单严重带偏。
    c.avgMarginPct = c.totalRevenueCny > 0 ? r2((c.totalProfitCny / c.totalRevenueCny) * 100) : 0
    c.orders.sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')))
  }
  return out.sort((a, b) => b.totalRevenueCny - a.totalRevenueCny)
}

/** 全部客户的合计(用于页头 KPI) */
export function totalOf(list: CustomerSummary[]) {
  const t = list.reduce((a, c) => ({
    customers: a.customers + 1,
    orderCount: a.orderCount + c.orderCount,
    quantity: a.quantity + c.totalQuantity,
    revenue: a.revenue + c.totalRevenueCny,
    cost: a.cost + c.totalCostCny,
    profit: a.profit + c.totalProfitCny,
    excluded: a.excluded + c.excludedMissingRate,
  }), { customers: 0, orderCount: 0, quantity: 0, revenue: 0, cost: 0, profit: 0, excluded: 0 })
  return { ...t, revenue: r2(t.revenue), cost: r2(t.cost), profit: r2(t.profit),
    marginPct: t.revenue > 0 ? r2((t.profit / t.revenue) * 100) : 0 }
}
