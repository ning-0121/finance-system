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
  // ar / orders 列集才有,其余列集为 undefined
  delivery_date?: string | null
  notes?: string | null
  ar_received_amount?: number | null
  ar_received_at?: string | null
  ar_received_bank?: string | null
  qimo_order_id?: string | null
  created_at?: string | null
  approved_at?: string | null
  estimated_profit?: number | null
  estimated_margin?: number | null
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
  /** 经营分析:成本桶 + 快照利润列(2026-08-18:此前用 buckets 缺 estimated_profit,渲染 null 崩页) */
  analytics: `${BASE}, ${BUCKETS}, ${META}`,
  /** 审批队列:META(利润列)+ notes(内部单号兜底解析;2026-08-19 审计:orders 列集缺 notes
   *  被 toRawOrders 补 null → 兜底解析恒失效,内部单号列静默显示 '-') */
  approvals: `${BASE}, ${META}, notes`,
  full: `${BASE}, ${BUCKETS}, ${AR}, ${META}`,
}

export type ColSet = 'lite' | 'buckets' | 'ar' | 'orders' | 'analytics' | 'approvals' | 'full'

export async function getOrderFinancials(cols: ColSet = 'buckets'): Promise<OrderFinancialRow[]> {
  const sb = createClient()
  // select 用动态字符串:Supabase 的类型层会去解析字面量 select,模板拼接它解析不了,
  // 故这里显式放宽(运行时行为不变,列名由 COL_SETS 保证)。
  const { data, error } = await fetchAll<OrderFinancialRow>((from, to) =>
    sb.from('v_order_financials').select(COL_SETS[cols] as never).order('id', { ascending: true }).range(from, to) as never)

  // ⚠️ 兜底(2026-08-08):视图切了 security_invoker=true 后,以调用者身份执行 ——
  // 若登录角色对底表权限/RLS 有任何一处不满足,整张视图读不出来,而调用方多半只会
  // 拿到空数组 → 页面一片空白,且看不出原因。这里改为【失败即回退旧路径】:
  // 宁可慢一点走 budget_orders 全量,也不能让财务打不开页面。
  if (error) {
    console.error('[order-financials] 视图读取失败,回退 budget_orders 直查:', error)
    return await fallbackFromBudgetOrders()
  }
  return data || []
}

/** 视图不可用时的退路:直查 budget_orders,字段名映射成视图形状(成本桶走标量列近似) */
async function fallbackFromBudgetOrders(): Promise<OrderFinancialRow[]> {
  const sb = createClient()
  const { data, error } = await fetchAll<Record<string, unknown>>((from, to) =>
    sb.from('budget_orders')
      .select('id, order_no, order_date, delivery_date, status, currency, exchange_rate, total_revenue, total_cost, customer_id, qimo_order_id, notes, created_at, approved_at, ar_received_amount, ar_received_at, ar_received_bank, estimated_profit, estimated_margin, target_purchase_price, estimated_commission, estimated_freight, estimated_customs_fee, other_costs, customers(company, country)')
      .is('deleted_at', null).order('id', { ascending: true }).range(from, to))
  if (error) { console.error('[order-financials] 回退路径也失败:', error); return [] }
  const num = (v: unknown) => Number(v) || 0
  return (data || []).map(r => {
    const cur = String(r.currency || 'CNY').toUpperCase()
    const rate = num(r.exchange_rate)
    const isCny = cur === 'CNY' || cur === 'RMB'
    const revenueCny = isCny ? num(r.total_revenue) : (rate > 0 ? num(r.total_revenue) * rate : null)
    const c = (r.customers as { company?: string; country?: string } | null) || null
    return {
      id: String(r.id), order_no: (r.order_no as string) ?? null, order_date: (r.order_date as string) ?? null,
      status: (r.status as string) ?? null, currency: (r.currency as string) ?? null,
      exchange_rate: r.exchange_rate as number ?? null, customer_id: (r.customer_id as string) ?? null,
      customer_company: c?.company ?? null, customer_country: c?.country ?? null,
      quantity: 0,     // 回退路径拿不到件数(件数在 synced_orders);页面会显示 0,属降级可接受
      is_junk: /^(CPX-|W1D-|TEST)/i.test(String(r.order_no || ''))
        || /测试/.test(String(c?.company || '')) || String(c?.company || '').trim().toLowerCase() === 'test',
      total_revenue: r.total_revenue as number ?? null, revenue_cny: revenueCny,
      cost_cny: num(r.total_cost),
      // 无 items 时只能用标量列近似(target_purchase_price 含采购成品+面料+辅料)
      c_finished_goods: 0, c_fabric: num(r.target_purchase_price), c_accessory: 0,
      c_processing: num(r.estimated_commission), c_forwarder: num(r.estimated_freight),
      c_container: num(r.estimated_customs_fee), c_logistics: num(r.other_costs), c_extras: 0,
      bucket_total: num(r.target_purchase_price) + num(r.estimated_commission) + num(r.estimated_freight)
        + num(r.estimated_customs_fee) + num(r.other_costs),
      actual_cost_cny: 0, actual_lines: 0,
      missing_rate: revenueCny === null, cost_completeness: null,
      delivery_date: (r.delivery_date as string) ?? null, notes: (r.notes as string) ?? null,
      ar_received_amount: r.ar_received_amount as number ?? null,
      ar_received_at: (r.ar_received_at as string) ?? null,
      ar_received_bank: (r.ar_received_bank as string) ?? null,
      qimo_order_id: (r.qimo_order_id as string) ?? null,
      created_at: (r.created_at as string) ?? null, approved_at: (r.approved_at as string) ?? null,
      estimated_profit: r.estimated_profit as number ?? null,
      estimated_margin: r.estimated_margin as number ?? null,
    } as OrderFinancialRow
  })
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
    // ⚠️ 这些列按列集可能不存在;必须原样透传,否则依赖它们的页面会静默拿到
    //    undefined(应收页的到期日/内部号/已收投影就是靠这几列)。
    //    调用方用 as unknown as BudgetOrder 转型会把这类缺字段问题藏起来,故在此集中兜住。
    delivery_date: r.delivery_date ?? null,
    notes: r.notes ?? null,
    ar_received_amount: r.ar_received_amount ?? null,
    ar_received_at: r.ar_received_at ?? null,
    ar_received_bank: r.ar_received_bank ?? null,
    qimo_order_id: r.qimo_order_id ?? null,
    created_at: r.created_at ?? null,
    approved_at: r.approved_at ?? null,
    estimated_profit: r.estimated_profit ?? null,
    estimated_margin: r.estimated_margin ?? null,
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
