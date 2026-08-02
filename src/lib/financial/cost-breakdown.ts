/**
 * 成本桶单一定义 + 合计口径(2026-08-02)
 *
 * ⚠️ 为什么要有这个文件:
 *   订单成本在库里有两个并存的表示 —— `budget_orders.total_cost`(标量总额,利润/毛利率/KPI 用)
 *   与 `items[0]._cost_breakdown` 的各个桶(订单页成本明细展示、决算对照用)。
 *   两者必须恒等,但桶的清单此前散在 7+ 个文件里各写一遍(订单页保存、决算页、
 *   GL 结转 gl-queue、gl-posting、Excel 导出、webhook 两条建单路径…)。
 *   2026-07-30 加第 7 个桶 finished_goods(采购成品)时就要挨个改 —— 漏改一处,
 *   该桶的钱就在那条路径上凭空消失或双计。生产实证:15 张 4 月已通过订单
 *   total_cost 与桶和不符(最大一张差 ¥197,534),就是这么来的。
 *
 * 所以:桶清单只在这里定义一次,合计只有这一个实现。加桶只改这个文件。
 */

/**
 * 成本桶清单(顺序即 UI 展示顺序)。加桶只加这里。
 * · gl     = 结转成本时借记的科目
 * · legacy = 无 _cost_breakdown 的历史单回退读哪个标量列(null=回退 0)
 *   ⚠️ fabric 回退 target_purchase_price,而该列 = 采购成品+面料+辅料,
 *      所以只在「完全没有 breakdown」时才可回退,否则会把采购成品双计。
 */
export const COST_BUCKETS = [
  // glDesc = 凭证行摘要,沿用各自历史文案(原本就不统一:面料/辅料带「成本」后缀,加工费等不带)
  { key: 'finished_goods', label: '采购成品', glDesc: '采购成品成本', gl: '540104', legacy: null },
  { key: 'fabric', label: '面料', glDesc: '面料成本', gl: '540101', legacy: 'target_purchase_price' },
  { key: 'accessory', label: '辅料', glDesc: '辅料成本', gl: '540102', legacy: null },
  { key: 'processing', label: '加工费', glDesc: '加工费', gl: '540103', legacy: 'estimated_commission' },
  { key: 'forwarder', label: '货代费', glDesc: '货代费', gl: '540201', legacy: 'estimated_freight' },
  { key: 'container', label: '装柜费', glDesc: '装柜费', gl: '540202', legacy: 'estimated_customs_fee' },
  { key: 'logistics', label: '物流费', glDesc: '物流费', gl: '540203', legacy: 'other_costs' },
] as const

/** 其他费用(extras)统一借记科目 */
export const EXTRAS_GL_ACCOUNT = '540204'

export type CostBucketKey = typeof COST_BUCKETS[number]['key']
export const COST_BUCKET_KEYS = COST_BUCKETS.map(b => b.key) as readonly CostBucketKey[]

const num = (v: unknown) => Number(v) || 0
const r2 = (v: number) => Math.round(v * 100) / 100

type Breakdown = Record<string, unknown> | null | undefined

/** 其他费用(extras)合计 */
export function sumExtras(cb: Breakdown): number {
  const ex = cb?.extras
  return Array.isArray(ex) ? r2(ex.reduce((s: number, e) => s + num((e as { amount?: unknown })?.amount), 0)) : 0
}

/** 成本桶合计 = 各桶 + 其他费用。这是「订单成本」的唯一算法。 */
export function sumCostBuckets(cb: Breakdown): number {
  if (!cb) return 0
  return r2(COST_BUCKET_KEYS.reduce((s, k) => s + num(cb[k]), 0) + sumExtras(cb))
}

/** 从订单的 items 里取出成本桶载体(约定挂在 items[0]._cost_breakdown) */
export function getCostBreakdown(items: unknown): Record<string, unknown> | null {
  const arr = items as Record<string, unknown>[] | null | undefined
  const cb = arr?.[0]?._cost_breakdown
  return (cb && typeof cb === 'object') ? cb as Record<string, unknown> : null
}

export interface ResolvedBuckets {
  /** 逐桶金额(CNY) */
  buckets: Record<CostBucketKey, number>
  extras: { name: string; amount: number }[]
  extrasTotal: number
  total: number
  /** 是否走了 _cost_breakdown(false = 无桶的历史单,回退了标量列) */
  fromBreakdown: boolean
}

/**
 * 解析一张订单的逐桶成本 —— GL 结转 / 决算对照的唯一取数口径。
 *
 * 规则(2026-07-30 定,曾因写反导致成本漏记与双计):
 *   有 _cost_breakdown → 一律以桶为准,0 也是有效值,**不回退**标量列;
 *   完全没有 breakdown 的历史单 → 才按 legacy 映射回退标量列。
 * ⚠️ 反过来写(`cb[k] || 标量列`)会:面料>0 时丢掉采购成品;
 *    纯经销单(面料=0)时又从 target_purchase_price 把采购成品再取一次 → 双计。
 */
export function resolveBucketAmounts(order: Record<string, unknown> | null | undefined): ResolvedBuckets {
  const cb = getCostBreakdown(order?.items)
  const buckets = {} as Record<CostBucketKey, number>
  for (const b of COST_BUCKETS) {
    buckets[b.key] = cb
      ? num(cb[b.key])
      : (b.legacy ? num(order?.[b.legacy]) : 0)
  }
  const rawExtras = cb?.extras
  const extras = (Array.isArray(rawExtras) ? rawExtras : [])
    .map(e => ({ name: String((e as { name?: unknown })?.name ?? ''), amount: num((e as { amount?: unknown })?.amount) }))
  const extrasTotal = r2(extras.reduce((s, e) => s + e.amount, 0))
  const total = r2(COST_BUCKETS.reduce((s, b) => s + buckets[b.key], 0) + extrasTotal)
  return { buckets, extras, extrasTotal, total, fromBreakdown: !!cb }
}

export interface CostConsistency {
  /** 有成本桶才可校验;无桶的历史单不参与 */
  checkable: boolean
  consistent: boolean
  storedTotal: number     // budget_orders.total_cost
  bucketTotal: number     // 各桶之和
  diff: number            // 桶 − 总额列(>0 = 总额列偏小 → 利润偏高)
}

/**
 * 校验「总额列」与「成本桶」是否一致。
 * ⚠️ 只报告,不自动改 —— 已通过/已过账订单的成本是审批基准,
 *    按老板铁律不允许被自动改写;由财务在 UI 上确认哪个口径为准。
 */
export function checkCostConsistency(order: { total_cost?: unknown; items?: unknown }): CostConsistency {
  const cb = getCostBreakdown(order?.items)
  const storedTotal = r2(num(order?.total_cost))
  if (!cb) return { checkable: false, consistent: true, storedTotal, bucketTotal: 0, diff: 0 }
  const bucketTotal = sumCostBuckets(cb)
  const diff = r2(bucketTotal - storedTotal)
  return { checkable: true, consistent: Math.abs(diff) < 0.02, storedTotal, bucketTotal, diff }
}
