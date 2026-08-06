import { describe, it, expect } from 'vitest'
import { metricsFor, seriesFor, changePct } from '../operating-report'
import { buildBenchmark, deviationOf, MIN_SAMPLES } from '../cost-benchmark'
import { monthRange, ALL_TIME } from '../period'

const cb = (b: Record<string, number>) => ({ items: [{ _cost_breakdown: b }] })
const o = (p: Record<string, unknown>) => ({
  id: 'x', status: 'approved', currency: 'CNY', order_date: '2026-07-10',
  total_revenue: 0, total_cost: 0, customer: { company: 'A' }, ...p,
})

describe('metricsFor —— 经营口径单期指标', () => {
  const jul = monthRange(2026, 7)

  it('按期归集,只计已通过/已关闭', () => {
    const m = metricsFor([
      o({ id: '1', total_revenue: 1000, total_cost: 600 }),
      o({ id: '2', total_revenue: 500, total_cost: 400, status: 'draft' }),
      o({ id: '3', total_revenue: 700, total_cost: 300, order_date: '2026-06-30' }),
    ], jul)
    expect(m.orderCount).toBe(1)
    expect(m.revenueCny).toBe(1000)
    expect(m.profitCny).toBe(400)
    expect(m.marginPct).toBe(40)
  })

  it('单件收入/单件成本', () => {
    const m = metricsFor([o({ id: '1', total_revenue: 10000, total_cost: 6000 })], jul, () => 1000)
    expect(m.quantity).toBe(1000)
    expect(m.revenuePerPc).toBe(10)
    expect(m.costPerPc).toBe(6)
  })

  it('无件数时单件指标给 0,不产生 Infinity', () => {
    const m = metricsFor([o({ id: '1', total_revenue: 100 })], jul, () => 0)
    expect(m.revenuePerPc).toBe(0)
    expect(Number.isFinite(m.costPerPc)).toBe(true)
  })

  it('外币缺汇率不计金额,但计订单数并报出排除数', () => {
    const m = metricsFor([
      o({ id: '1', currency: 'USD', exchange_rate: 7, total_revenue: 100 }),
      o({ id: '2', currency: 'USD', exchange_rate: null, total_revenue: 9999 }),
    ], jul)
    expect(m.revenueCny).toBe(700)
    expect(m.orderCount).toBe(2)
    expect(m.excludedMissingRate).toBe(1)
  })

  it('客户数去重', () => {
    const m = metricsFor([
      o({ id: '1', customer: { company: 'A' } }),
      o({ id: '2', customer: { company: 'A' } }),
      o({ id: '3', customer: { company: 'B' } }),
    ], jul)
    expect(m.customerCount).toBe(2)
  })

  it('成本结构按桶汇总', () => {
    const m = metricsFor([
      o({ id: '1', total_cost: 300, ...cb({ fabric: 200, processing: 100 }) }),
      o({ id: '2', total_cost: 150, ...cb({ fabric: 50, forwarder: 100 }) }),
    ], jul)
    expect(m.buckets.fabric).toBe(250)
    expect(m.buckets.processing).toBe(100)
    expect(m.buckets.forwarder).toBe(100)
  })
})

describe('seriesFor / changePct', () => {
  it('多期序列按传入顺序', () => {
    const s = seriesFor([o({ id: '1', order_date: '2026-07-05', total_revenue: 100 })],
      [monthRange(2026, 6), monthRange(2026, 7)])
    expect(s[0].revenueCny).toBe(0)
    expect(s[1].revenueCny).toBe(100)
  })
  it('基期为 0 或缺失时返回 null,不假装 0% 或 Infinity', () => {
    expect(changePct(100, 0)).toBeNull()
    expect(changePct(100, null)).toBeNull()
    expect(changePct(100, undefined)).toBeNull()
    expect(changePct(150, 100)).toBe(50)
    expect(changePct(50, 100)).toBe(-50)
  })
  it('基期为负时按绝对值算变化率', () => {
    expect(changePct(-50, -100)).toBe(50)
  })
})

describe('成本基准 —— 单件化 + 中位数', () => {
  const mk = (id: string, fabric: number, qty: number) =>
    o({ id, total_cost: fabric, ...cb({ fabric }) , _q: qty })
  const qtyOf = (m: Record<string, number>) => (id: string) => m[id] || 0

  it('按单件成本建基准,中位数不被异常单带偏', () => {
    // 五单单件面料费:2,3,4,5,100(最后一张异常)
    const orders = [mk('1', 200, 100), mk('2', 300, 100), mk('3', 400, 100), mk('4', 500, 100), mk('5', 10000, 100)]
    const q = qtyOf({ '1': 100, '2': 100, '3': 100, '4': 100, '5': 100 })
    const st = buildBenchmark(orders, ALL_TIME, q).find(s => s.group === 'material')!
    expect(st.n).toBe(5)
    expect(st.median).toBe(4)          // 平均数会是 22.8,被那张 100 拉走
    expect(st.max).toBe(100)
    expect(st.reliable).toBe(true)
  })

  it('样本不足时标记不可靠', () => {
    const st = buildBenchmark([mk('1', 200, 100)], ALL_TIME, qtyOf({ '1': 100 })).find(s => s.group === 'material')!
    expect(st.n).toBeLessThan(MIN_SAMPLES)
    expect(st.reliable).toBe(false)
  })

  it('无件数或该项无成本的单不进样本(否则会把基准压低)', () => {
    const st = buildBenchmark([mk('1', 200, 0), o({ id: '2', ...cb({ fabric: 0 }) })],
      ALL_TIME, qtyOf({ '2': 100 })).find(s => s.group === 'material')!
    expect(st.n).toBe(0)
  })

  it('可按客户过滤', () => {
    const orders = [
      o({ id: '1', customer: { company: 'A' }, total_cost: 200, ...cb({ fabric: 200 }) }),
      o({ id: '2', customer: { company: 'B' }, total_cost: 900, ...cb({ fabric: 900 }) }),
    ]
    const st = buildBenchmark(orders, ALL_TIME, () => 100, { customer: 'A' }).find(s => s.group === 'material')!
    expect(st.n).toBe(1)
    expect(st.median).toBe(2)
  })
})

describe('偏离预警', () => {
  const q = () => 100
  const base = Array.from({ length: 6 }, (_, i) =>
    o({ id: `b${i}`, total_cost: 400 + i * 10, ...cb({ fabric: 400 + i * 10 }) }))

  it('明显高于中位数 → high,并给出可执行建议', () => {
    const stats = buildBenchmark(base, ALL_TIME, q)
    const d = deviationOf(o({ id: 'x', ...cb({ fabric: 2000 }) }), 100, stats)
      .find(x => x.group === 'material')!
    expect(d.severity).toBe('high')
    expect(d.perPc).toBe(20)
    expect(d.note).toContain('核查报价或供应商')
  })

  it('处于区间内 → normal', () => {
    const stats = buildBenchmark(base, ALL_TIME, q)
    const d = deviationOf(o({ id: 'x', ...cb({ fabric: 430 }) }), 100, stats)
      .find(x => x.group === 'material')!
    expect(d.severity).toBe('normal')
  })

  it('样本不足时不下结论,明说仅供参考', () => {
    const stats = buildBenchmark([base[0]], ALL_TIME, q)
    const d = deviationOf(o({ id: 'x', ...cb({ fabric: 9999 }) }), 100, stats)
      .find(x => x.group === 'material')!
    expect(d.reliable).toBe(false)
    expect(d.note).toContain('不足以形成基准')
  })
})

describe('成本录入完整度 —— 治「毛利率虚高」', () => {
  const jul = monthRange(2026, 7)
  const mk = (id: string, rev: number, cost: number, buckets: Record<string, number>) =>
    o({ id, total_revenue: rev, total_cost: cost, ...cb(buckets) })

  it('未录成本 → none;有料工费但缺出运 → minimal;≥5桶含出运 → full', () => {
    const m = metricsFor([
      mk('n', 1000, 500, {}),
      mk('mi', 1000, 500, { fabric: 300, accessory: 100, processing: 100 }),
      mk('fu', 1000, 500, { fabric: 200, accessory: 100, processing: 100, forwarder: 50, container: 50 }),
    ], jul)
    expect(m.byCompleteness.none.n).toBe(1)
    expect(m.byCompleteness.minimal.n).toBe(1)
    expect(m.byCompleteness.full.n).toBe(1)
  })

  it('可信毛利率只算成本齐备的单 —— 这是本次修正的核心', () => {
    const m = metricsFor([
      // 成本齐备:毛利率 20%
      mk('a', 1000, 800, { fabric: 400, accessory: 100, processing: 200, forwarder: 50, container: 50 }),
      // 未录成本:毛利率 90%,会把全口径拉高
      mk('b', 1000, 100, {}),
    ], jul)
    expect(m.marginPct).toBe(55)              // 全口径被虚高单拉到 55%
    expect(m.trustedMarginPct).toBe(20)       // 可信口径仍是 20%
    expect(m.trustedOrderCount).toBe(1)
  })

  it('缺出运成本单独归档 —— 生产实证这类毛利率 47% vs 有出运的 18%', () => {
    const m = metricsFor([mk('x', 1000, 500, { fabric: 300, accessory: 100, processing: 100 })], jul)
    expect(m.byCompleteness.minimal.n).toBe(1)
    expect(m.byCompleteness.full.n).toBe(0)
    expect(m.trustedOrderCount).toBe(0)       // 没有可信样本时不给可信毛利率
    expect(m.trustedMarginPct).toBe(0)
  })

  it('残单(有收无本/有本无收)不进完整度分层,免得污染分母', () => {
    const m = metricsFor([
      o({ id: 'nc', total_revenue: 1000, total_cost: 0 }),
      o({ id: 'nr', total_revenue: 0, total_cost: 500 }),
    ], jul)
    const total = Object.values(m.byCompleteness).reduce((a, v) => a + v.n, 0)
    expect(total).toBe(0)
    expect(m.noCostCount).toBe(1)
    expect(m.noRevenueCount).toBe(1)
  })
})

describe('口径与测试单', () => {
  const jul = monthRange(2026, 7)
  it('已审核口径不含草稿;全口径含草稿但不含驳回', () => {
    const list = [o({ id: '1', status: 'approved', total_revenue: 100 }),
                  o({ id: '2', status: 'draft', total_revenue: 100 }),
                  o({ id: '3', status: 'rejected', total_revenue: 100 })]
    expect(metricsFor(list, jul, () => 0, 'approved').orderCount).toBe(1)
    expect(metricsFor(list, jul, () => 0, 'all').orderCount).toBe(2)
  })
  it('测试单在任何口径都不计入', () => {
    const list = [o({ id: '1', order_no: 'CPX-123', total_revenue: 9999 }),
                  o({ id: '2', order_no: 'W1D-9', total_revenue: 9999 }),
                  o({ id: '3', customer: { company: '测试' }, total_revenue: 9999 }),
                  o({ id: '4', order_no: 'BO-1', total_revenue: 100 })]
    expect(metricsFor(list, jul, () => 0, 'all').orderCount).toBe(1)
    expect(metricsFor(list, jul, () => 0, 'all').revenueCny).toBe(100)
  })
})
