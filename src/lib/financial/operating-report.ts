/**
 * 经营报表聚合(2026-08-04):按月 / 季 / 年看收入、成本、利润、订单数、件数。
 *
 * 与「会计三大报表」的区别必须说清楚,否则两边数字对不上时会互相怀疑:
 *  · 本报表 = 【经营口径】,按订单 order_date 归期,数据来自 budget_orders,
 *    反映"这个月接的单赚不赚钱";口径与订单成本核算页、客户财务档案完全一致。
 *  · 利润表/资产负债表 = 【会计口径】,按已过账凭证归期,受权责发生制与结账约束。
 *  两者天然不等(收入确认时点不同),不是 bug。
 *
 * 口径纪律与客户档案同源(见 customer-summary.ts):
 *  只计已通过/已关闭;先折汇再相加;外币缺汇率不硬算、单列不计入。
 */
import { computeOrderProfit } from './order-profit'
import { inPeriod, type PeriodRange } from './period'
import { isCounted, type RawOrder } from './customer-summary'
import { resolveBucketAmounts } from './cost-breakdown'

const num = (v: unknown) => Number(v) || 0
const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * 统计口径(2026-08-04 老板决策):
 *  · approved —— 只算已通过/已关闭。严谨,与 KPI/总账同源,但当前仅 38 张,看不出经营全貌。
 *  · all      —— 含草稿与待审。能看真实接单节奏,但草稿的价格与成本【未经财务核过】,
 *                只可用于看趋势,不可用于对账或报税。
 * 两个口径必须在 UI 上并排标注、不可混用。
 */
export type Scope = 'approved' | 'all'

/**
 * 测试/垃圾单识别:单号前缀异常或客户名含"测试"。
 * 生产实测有 CPX- / W1D- 前缀的自动生成单(金额 ¥10000/¥100 这类整数),
 * 混进报表会污染件数与收入。
 */
export function isJunkOrder(o: { order_no?: string | null; customer?: { company?: string | null } | null }): boolean {
  if (/^(CPX-|W1D-|TEST)/i.test(String(o?.order_no || ''))) return true
  return /测试|^test$/i.test(String(o?.customer?.company || '').trim())
}

/** 该单是否计入指定口径 */
export function inScope(o: { status?: string | null }, scope: Scope): boolean {
  if (scope === 'approved') return isCounted(o.status)
  return String(o.status || '') !== 'rejected'      // 全口径也排除已驳回
}

export interface PeriodMetrics {
  period: PeriodRange
  orderCount: number
  quantity: number
  customerCount: number
  revenueCny: number
  costCny: number
  profitCny: number
  marginPct: number
  /** 单件收入 / 单件成本 —— 比总额更能看出经营质量的变化 */
  revenuePerPc: number
  costPerPc: number
  /** 缺汇率被排除的订单数 */
  excludedMissingRate: number
  /** 数据质量:有收入无成本(利润率虚高) */
  noCostCount: number
  /** 数据质量:有成本无收入(拉低利润率) */
  noRevenueCount: number
  /** 数据质量:取不到件数的订单数 —— 件数合计会因此偏低 */
  noQuantityCount: number
  /** 剔除上述两类不完整单后的"干净"口径 */
  cleanRevenueCny: number
  cleanCostCny: number
  cleanProfitCny: number
  cleanMarginPct: number
  cleanOrderCount: number
  /** 成本结构:各桶合计(CNY) */
  buckets: Record<string, number>
}

export interface RawOrderWithItems extends RawOrder {
  items?: unknown
  target_purchase_price?: number | string | null
  estimated_commission?: number | string | null
  estimated_freight?: number | string | null
  estimated_customs_fee?: number | string | null
  other_costs?: number | string | null
}

/** 单期指标 */
export function metricsFor(
  orders: RawOrderWithItems[],
  period: PeriodRange,
  quantityOf: (id: string) => number = () => 0,
  scope: Scope = 'approved',
): PeriodMetrics {
  const m: PeriodMetrics = {
    period, orderCount: 0, quantity: 0, customerCount: 0,
    revenueCny: 0, costCny: 0, profitCny: 0, marginPct: 0,
    revenuePerPc: 0, costPerPc: 0, excludedMissingRate: 0, buckets: {},
    noCostCount: 0, noRevenueCount: 0, noQuantityCount: 0,
    cleanRevenueCny: 0, cleanCostCny: 0, cleanProfitCny: 0, cleanMarginPct: 0, cleanOrderCount: 0,
  }
  const customers = new Set<string>()

  for (const o of orders) {
    if (isJunkOrder(o)) continue          // 测试单不进任何口径
    if (!inScope(o, scope)) continue
    if (!inPeriod(o.order_date, period)) continue

    m.orderCount += 1
    const qty = num(quantityOf(o.id))
    m.quantity += qty
    if (qty <= 0) m.noQuantityCount += 1
    customers.add(o.customer?.company?.trim() || '未知客户')

    const calc = computeOrderProfit(o)
    if (!calc.usable && calc.reason === 'missing_rate') { m.excludedMissingRate += 1; continue }

    const cost = r2(num(o.total_cost))
    m.revenueCny += calc.revenueCny
    m.costCny += cost
    m.profitCny += calc.profitCny

    // 数据完整度:两类残单会同时往相反方向污染利润率,必须单独计数并给出"干净"口径
    if (calc.revenueCny > 0 && cost === 0) m.noCostCount += 1
    else if (calc.revenueCny === 0 && cost > 0) m.noRevenueCount += 1
    else if (calc.revenueCny > 0 && cost > 0) {
      m.cleanOrderCount += 1
      m.cleanRevenueCny += calc.revenueCny
      m.cleanCostCny += cost
      m.cleanProfitCny += calc.profitCny
    }

    // 成本结构走公共实现(桶清单唯一定义,加桶自动跟上)
    const rb = resolveBucketAmounts(o as unknown as Record<string, unknown>)
    for (const [k, v] of Object.entries(rb.buckets)) m.buckets[k] = r2((m.buckets[k] || 0) + v)
    if (rb.extrasTotal) m.buckets.extras = r2((m.buckets.extras || 0) + rb.extrasTotal)
  }

  m.customerCount = customers.size
  m.revenueCny = r2(m.revenueCny); m.costCny = r2(m.costCny); m.profitCny = r2(m.profitCny)
  m.marginPct = m.revenueCny > 0 ? r2((m.profitCny / m.revenueCny) * 100) : 0
  m.cleanRevenueCny = r2(m.cleanRevenueCny); m.cleanCostCny = r2(m.cleanCostCny); m.cleanProfitCny = r2(m.cleanProfitCny)
  m.cleanMarginPct = m.cleanRevenueCny > 0 ? r2((m.cleanProfitCny / m.cleanRevenueCny) * 100) : 0
  m.revenuePerPc = m.quantity > 0 ? r2(m.revenueCny / m.quantity) : 0
  m.costPerPc = m.quantity > 0 ? r2(m.costCny / m.quantity) : 0
  return m
}

/** 多期序列(用于趋势与环比),入参周期顺序即输出顺序 */
export function seriesFor(
  orders: RawOrderWithItems[],
  periods: PeriodRange[],
  quantityOf?: (id: string) => number,
  scope: Scope = 'approved',
): PeriodMetrics[] {
  return periods.map(p => metricsFor(orders, p, quantityOf, scope))
}

/**
 * 变化率。基期为 0 或缺失时返回 null —— 不返回 0 也不返回 Infinity,
 * 因为「从 0 涨到 100」和「没变化」是两回事,UI 要能区分出「—」。
 */
export function changePct(current: number, base: number | undefined | null): number | null {
  if (base == null || base === 0) return null
  return r2(((current - base) / Math.abs(base)) * 100)
}
