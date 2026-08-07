/**
 * 订单财务口径取数(2026-08-06)—— 从视图 v_order_financials 读,替代前端全量拉 budget_orders。
 *
 * 为什么这么切:
 *  · 原先每个报表页都 getBudgetOrders()(639 行 / 1.62 MB,含 customers join),
 *    还要再单独取一次 items 才拿得到成本桶,前端再算 —— 中国→美国机房往返下明显卡。
 *  · 视图已在库里把成本桶、收入折算、完整度分档算好,全量 644 行仅 446 KB(降 73%),
 *    且不含任何大 JSONB。
 *
 * ⚠️ 关键设计:本函数把视图行【还原成现有 TS 聚合函数认识的形状】(含合成
 *    items[0]._cost_breakdown),从而 metricsFor / summarizeCustomers / buildBenchmark
 *    等全部已测逻辑一行不用改。换的是数据源,不是口径 —— 口径已做过 641 单逐单交叉校验。
 */
import { createClient } from './client'
import { fetchAll } from './fetch-all'
import type { RawOrderWithItems } from '@/lib/financial/operating-report'

export interface OrderFinancialRow {
  id: string
  order_no: string | null
  order_date: string | null
  status: string | null
  currency: string | null
  exchange_rate: number | null
  customer_id: string | null
  customer_company: string | null
  customer_country: string | null
  quantity: number | null
  is_junk: boolean
  total_revenue: number | null
  revenue_cny: number | null
  cost_cny: number | null
  c_finished_goods: number | null
  c_fabric: number | null
  c_accessory: number | null
  c_processing: number | null
  c_forwarder: number | null
  c_container: number | null
  c_logistics: number | null
  c_extras: number | null
  bucket_total: number | null
  actual_cost_cny: number | null
  actual_lines: number | null
  missing_rate: boolean
  cost_completeness: string | null
}

/**
 * 列集预设 —— 页面只拉自己要的列。
 * 视图全列 47 个共 736KB;lite 只有 15 列,体积约 1/3。
 * 不要图省事一律用 full:传输量是这次优化的主要目标。
 */
const BASE = 'id, order_no, order_date, status, currency, exchange_rate, customer_id, customer_company, customer_country, quantity, is_junk, total_revenue, revenue_cny, cost_cny, missing_rate'
const BUCKETS = 'c_finished_goods, c_fabric, c_accessory, c_processing, c_forwarder, c_container, c_logistics, c_extras, bucket_total, cost_completeness, filled_buckets, has_shipping_cost, actual_cost_cny, actual_lines'
const AR = 'delivery_date, notes, ar_received_amount, ar_received_at, ar_received_bank'
const META = 'qimo_order_id, created_at, approved_at, estimated_profit, estimated_margin'

export const COL_SETS: Record<string, string> = {
  /** 只要金额与件数:工作台、审批队列、付款页 */
  lite: BASE,
  /** 需要成本桶:经营报表、成本基准、客户成本对比 */
  buckets: `${BASE}, ${BUCKETS}`,
  /** 应收页:另需交期/备注/回款投影 */
  ar: `${BASE}, ${AR}`,
  /** 订单列表:另需快照利润列作兜底 */
  orders: `${BASE}, ${META}`,
  full: `${BASE}, ${BUCKETS}, ${AR}, ${META}`,
}

export type ColSet = 'lite' | 'buckets' | 'ar' | 'orders' | 'full'

export async function getOrderFinancials(cols: ColSet = 'buckets'): Promise<OrderFinancialRow[]> {
  const sb = createClient()
  // select 用动态字符串:Supabase 的类型层会去解析字面量 select,模板拼接它解析不了,
  // 故这里显式放宽(运行时行为不变,列名由 COL_SETS 保证)。
  const { data, error } = await fetchAll<OrderFinancialRow>((from, to) =>
    sb.from('v_order_financials').select(COL_SETS[cols] as never).order('id', { ascending: true }).range(from, to) as never)
  if (error) { console.error('[order-financials] 读取失败:', error); return [] }
  return data || []
}

/**
 * 视图行 → 现有 TS 聚合函数的入参形状。
 * 合成 items[0]._cost_breakdown,使 resolveBucketAmounts 走「有桶」分支,
 * 不会误回退到旧标量列(那正是 2026-08-06 修掉的 bug)。
 */
export function toRawOrders(rows: OrderFinancialRow[]): (RawOrderWithItems & { _quantity: number })[] {
  return rows.map(r => ({
    id: r.id,
    order_no: r.order_no,
    order_date: r.order_date,
    status: r.status,
    currency: r.currency,
    exchange_rate: r.exchange_rate,
    total_revenue: r.total_revenue,
    total_cost: r.cost_cny,
    customer: { company: r.customer_company, country: r.customer_country },
    items: [{
      _cost_breakdown: {
        finished_goods: r.c_finished_goods ?? 0,
        fabric: r.c_fabric ?? 0,
        accessory: r.c_accessory ?? 0,
        processing: r.c_processing ?? 0,
        forwarder: r.c_forwarder ?? 0,
        container: r.c_container ?? 0,
        logistics: r.c_logistics ?? 0,
        // extras 在视图里已聚成一个数,还原成单元素数组以保持 sumCostBuckets 的语义
        extras: (r.c_extras ?? 0) > 0 ? [{ name: '其他费用', amount: r.c_extras }] : [],
      },
    }],
    _quantity: Number(r.quantity) || 0,
  }))
}

/** 件数索引 —— 视图已带,不必再查 synced_orders */
export function quantityMapOf(rows: OrderFinancialRow[]): Record<string, number> {
  const m: Record<string, number> = {}
  for (const r of rows) m[r.id] = Number(r.quantity) || 0
  return m
}
