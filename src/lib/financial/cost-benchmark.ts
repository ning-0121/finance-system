/**
 * 成本基准对比(2026-08-04)—— 只读、规则可解释,不用 AI。
 *
 * 为什么先做规则而不是 AI:定价与成本建议要准,前提是有足够的历史基准。
 * 现在样本还薄,AI 只会给出"看起来很专业的猜测"。规则版的好处是每个结论
 * 都能追到是哪几张单算出来的,财务可以自己判断该不该信 —— 也符合治理铁律
 * (只做比对与警示,读多写零)。等样本厚了,AI 可以在这层之上做解释与建议。
 *
 * 核心思路:把成本【单件化】再比。不同订单件数差几十倍,总额没有可比性;
 * 单件面料费、单件加工费、单件海运费才是能横向比的东西。
 *
 * 统计口径:用【中位数】而非平均数作为基准 —— 服装订单成本长尾明显,
 * 一张异常单就能把平均数拉走;中位数与四分位距对异常值稳健得多。
 */
import { inPeriod, isAllTime, type PeriodRange } from './period'
import { isCounted } from './customer-summary'
import { resolveBucketAmounts, COST_BUCKETS, type CostBucketKey } from './cost-breakdown'
import type { RawOrderWithItems } from './operating-report'

const num = (v: unknown) => Number(v) || 0
const r2 = (v: number) => Math.round(v * 100) / 100

/** 参与对比的成本项:原辅料、加工费、海运(货代+物流)——老板点名关注的三类 */
export const BENCHMARK_GROUPS = [
  { key: 'material', label: '原辅料', buckets: ['finished_goods', 'fabric', 'accessory'] },
  { key: 'processing', label: '加工费', buckets: ['processing'] },
  { key: 'shipping', label: '海运及物流', buckets: ['forwarder', 'container', 'logistics'] },
] as const
export type BenchmarkGroupKey = typeof BENCHMARK_GROUPS[number]['key']

export interface Sample {
  orderId: string
  orderNo: string
  customer: string
  orderDate: string | null
  quantity: number
  /** 该组的单件成本(CNY/件) */
  perPc: number
  amount: number
}

export interface BenchmarkStat {
  group: BenchmarkGroupKey
  label: string
  n: number
  min: number
  p25: number
  median: number
  p75: number
  max: number
  /** 样本是否足够形成基准。少于 5 单时结论不可靠,UI 必须标注 */
  reliable: boolean
  samples: Sample[]
}

/** 分位数(线性插值),输入需已升序 */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** 样本量下限:低于此不足以作基准 */
export const MIN_SAMPLES = 5

export function buildBenchmark(
  orders: RawOrderWithItems[],
  period: PeriodRange,
  quantityOf: (id: string) => number,
  filter?: { customer?: string },
): BenchmarkStat[] {
  return BENCHMARK_GROUPS.map(g => {
    const samples: Sample[] = []
    for (const o of orders) {
      if (!isCounted(o.status)) continue
      if (!isAllTime(period) && !inPeriod(o.order_date, period)) continue
      const cust = o.customer?.company?.trim() || '未知客户'
      if (filter?.customer && cust !== filter.customer) continue
      const qty = num(quantityOf(o.id))
      if (qty <= 0) continue                      // 无件数无法单件化,不进样本
      const rb = resolveBucketAmounts(o as unknown as Record<string, unknown>)
      const amount = g.buckets.reduce((s, b) => s + num(rb.buckets[b as CostBucketKey]), 0)
      if (amount <= 0) continue                   // 该组没成本(如未录),不进样本免得把基准压低
      samples.push({
        orderId: o.id, orderNo: o.order_no || '', customer: cust,
        orderDate: o.order_date ?? null, quantity: qty,
        perPc: r2(amount / qty), amount: r2(amount),
      })
    }
    const vals = samples.map(s => s.perPc).sort((a, b) => a - b)
    return {
      group: g.key, label: g.label, n: vals.length,
      min: r2(vals[0] ?? 0), p25: r2(quantile(vals, .25)), median: r2(quantile(vals, .5)),
      p75: r2(quantile(vals, .75)), max: r2(vals[vals.length - 1] ?? 0),
      reliable: vals.length >= MIN_SAMPLES,
      samples: samples.sort((a, b) => b.perPc - a.perPc),
    }
  })
}

export type Severity = 'normal' | 'watch' | 'high'

export interface Deviation {
  group: BenchmarkGroupKey
  label: string
  perPc: number
  median: number
  /** 相对中位数的偏离百分比 */
  deviationPct: number
  severity: Severity
  reliable: boolean
  note: string
}

/**
 * 单张订单与基准的偏离。
 * 分档用四分位距(IQR)而非固定百分比 —— 不同成本项的天然离散度差很多,
 * 用一刀切的 ±20% 会让波动大的项天天报警、波动小的项永远不报。
 */
export function deviationOf(
  order: RawOrderWithItems,
  quantity: number,
  stats: BenchmarkStat[],
): Deviation[] {
  const rb = resolveBucketAmounts(order as unknown as Record<string, unknown>)
  return BENCHMARK_GROUPS.map(g => {
    const st = stats.find(s => s.group === g.key)!
    const amount = g.buckets.reduce((s, b) => s + num(rb.buckets[b as CostBucketKey]), 0)
    const perPc = quantity > 0 ? r2(amount / quantity) : 0
    const median = st.median
    const iqr = Math.max(st.p75 - st.p25, median * 0.05)   // IQR 退化为 0 时用中位数的 5% 兜底
    const diff = perPc - median
    const devPct = median > 0 ? r2((diff / median) * 100) : 0

    let severity: Severity = 'normal'
    if (median > 0 && perPc > 0) {
      if (diff > iqr * 1.5) severity = 'high'
      else if (diff > iqr * 0.75) severity = 'watch'
    }
    const note = !st.reliable
      ? `样本仅 ${st.n} 单，不足以形成基准，仅供参考`
      : perPc <= 0 ? '本单该项无成本'
      : severity === 'high' ? `明显高于同期中位数 ¥${median}/件，建议核查报价或供应商`
      : severity === 'watch' ? `高于同期中位数 ¥${median}/件，可关注`
      : `处于正常区间（中位 ¥${median}/件）`

    return { group: g.key, label: g.label, perPc, median, deviationPct: devPct,
      severity, reliable: st.reliable, note }
  })
}
