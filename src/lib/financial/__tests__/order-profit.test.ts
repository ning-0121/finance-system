import { describe, it, expect } from 'vitest'
import { computeOrderProfit, effectiveProfit, effectiveMargin } from '../order-profit'

describe('computeOrderProfit —— 收入按原币×汇率折 CNY', () => {
  it('人民币直收单:收入即 CNY', () => {
    const c = computeOrderProfit({ currency: 'CNY', total_revenue: 10000, total_cost: 8000 })
    expect(c.usable).toBe(true)
    expect(c.revenueCny).toBe(10000)
    expect(c.profitCny).toBe(2000)
    expect(c.marginPct).toBe(20)
  })

  it('外币单必须先折汇 —— 直接相减会算出荒谬的负毛利(审计时我踩过这个坑)', () => {
    // 真实形态:收 5952 USD @6.82,成本 ¥35,939.06
    const c = computeOrderProfit({ currency: 'USD', exchange_rate: 6.82, total_revenue: 5952, total_cost: 35939.06 })
    expect(c.revenueCny).toBe(40592.64)
    expect(c.marginPct).toBeCloseTo(11.46, 1)   // 合理毛利
    // 若误按「收入−成本」不折汇:5952 − 35939 = −29987,毛利 −503%,明显失真
    expect(c.profitCny).toBeGreaterThan(0)
  })

  it('外币缺汇率 → usable=false,绝不按 1:1 硬算', () => {
    const c = computeOrderProfit({ currency: 'USD', exchange_rate: null, total_revenue: 32169.6, total_cost: 0 })
    expect(c.usable).toBe(false)
    expect(c.reason).toBe('missing_rate')
    expect(c.profitCny).toBe(0)     // 调用方须据 usable 显示「缺汇率」,而不是把这个 0 当利润
  })

  it('汇率为 0 / 负数同样视为缺率', () => {
    expect(computeOrderProfit({ currency: 'USD', exchange_rate: 0, total_revenue: 100 }).usable).toBe(false)
    expect(computeOrderProfit({ currency: 'USD', exchange_rate: -1, total_revenue: 100 }).usable).toBe(false)
  })

  it('成本为 0 → 利润=全部收入(这类单此前列里存 0,显示成没利润)', () => {
    const c = computeOrderProfit({ currency: 'USD', exchange_rate: 6.78, total_revenue: 169257.6, total_cost: 0 })
    expect(c.profitCny).toBe(1147566.53)
    expect(c.marginPct).toBe(100)
  })

  it('RMB 视同 CNY', () => {
    expect(computeOrderProfit({ currency: 'RMB', total_revenue: 100, total_cost: 40 }).profitCny).toBe(60)
  })

  it('收入为 0 时毛利率给 0 而非 NaN/Infinity', () => {
    const c = computeOrderProfit({ currency: 'CNY', total_revenue: 0, total_cost: 500 })
    expect(c.marginPct).toBe(0)
    expect(Number.isFinite(c.profitCny)).toBe(true)
  })
})

describe('effectiveProfit / effectiveMargin —— 决算优先,其次现算,最后才读快照列', () => {
  const order = { currency: 'USD', exchange_rate: 7, total_revenue: 1000, total_cost: 3000, estimated_profit: 0, estimated_margin: 0 }

  it('决算已确认 → 用决算实际数', () => {
    expect(effectiveProfit(order, { status: 'confirmed', final_profit: 12345 })).toBe(12345)
    expect(effectiveMargin(order, { status: 'locked', final_margin: 33 })).toBe(33)
  })

  it('决算未确认 → 现算,不再读存着 0 的快照列(478 张的正是这个形态)', () => {
    expect(effectiveProfit(order, { status: 'draft', final_profit: 999 })).toBe(4000)  // 1000*7-3000
    expect(effectiveMargin(order, null)).toBe(57.14)
  })

  it('现算不可用(外币缺率)→ 才回落快照列', () => {
    const noRate = { currency: 'USD', exchange_rate: null, total_revenue: 1000, total_cost: 0, estimated_profit: 777, estimated_margin: 12 }
    expect(effectiveProfit(noRate, null)).toBe(777)
    expect(effectiveMargin(noRate, null)).toBe(12)
  })
})
