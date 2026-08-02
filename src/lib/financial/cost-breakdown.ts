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

/** 成本桶清单(顺序即 UI 展示顺序)。加桶只加这里。 */
export const COST_BUCKETS = [
  { key: 'finished_goods', label: '采购成品', gl: '540104' },
  { key: 'fabric', label: '面料', gl: '540101' },
  { key: 'accessory', label: '辅料', gl: '540102' },
  { key: 'processing', label: '加工费', gl: '540103' },
  { key: 'forwarder', label: '货代费', gl: '540201' },
  { key: 'container', label: '装柜费', gl: '540202' },
  { key: 'logistics', label: '物流费', gl: '540203' },
] as const

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
