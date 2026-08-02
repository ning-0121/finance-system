import { describe, it, expect } from 'vitest'
import { COST_BUCKET_KEYS, sumCostBuckets, checkCostConsistency, getCostBreakdown } from '../cost-breakdown'

describe('成本桶清单', () => {
  it('七个桶齐全,采购成品在列(2026-07-30 新增,曾漏配多处)', () => {
    expect(COST_BUCKET_KEYS).toEqual([
      'finished_goods', 'fabric', 'accessory', 'processing', 'forwarder', 'container', 'logistics',
    ])
  })
})

describe('sumCostBuckets —— 唯一合计实现', () => {
  it('各桶 + 其他费用', () => {
    expect(sumCostBuckets({
      finished_goods: 300, fabric: 500, accessory: 100, processing: 200,
      forwarder: 50, container: 30, logistics: 20,
      extras: [{ name: '税', amount: 10 }, { name: '杂费', amount: 5 }],
    })).toBe(1215)
  })
  it('缺桶按 0 计,不 NaN', () => {
    expect(sumCostBuckets({ fabric: 100 })).toBe(100)
    expect(sumCostBuckets({})).toBe(0)
    expect(sumCostBuckets(null)).toBe(0)
  })
  it('字符串数字也能算(历史 JSONB 里混过字符串)', () => {
    expect(sumCostBuckets({ fabric: '100.5', accessory: '9.5' })).toBe(110)
  })
  it('采购成品必须计入 —— 漏了就是经销单成本凭空消失', () => {
    expect(sumCostBuckets({ finished_goods: 800 })).toBe(800)
  })
})

describe('checkCostConsistency —— 只报告不改数', () => {
  const withCb = (cb: Record<string, unknown>, total: number) => ({ total_cost: total, items: [{ _cost_breakdown: cb }] })

  it('一致时不告警', () => {
    const c = checkCostConsistency(withCb({ fabric: 500, accessory: 100 }, 600))
    expect(c.checkable).toBe(true); expect(c.consistent).toBe(true); expect(c.diff).toBe(0)
  })
  it('桶大于总额列 → 利润偏高(生产实证 BO-202604-0057 形态)', () => {
    const c = checkCostConsistency(withCb({ fabric: 82969.92, accessory: 31622.4, processing: 135014.4, forwarder: 5000, container: 800, logistics: 1000 }, 58872))
    expect(c.consistent).toBe(false)
    expect(c.bucketTotal).toBe(256406.72)
    expect(c.storedTotal).toBe(58872)
    expect(c.diff).toBe(197534.72)   // >0 = 总额列偏小 = 利润偏高
  })
  it('桶小于总额列 → 利润偏低', () => {
    const c = checkCostConsistency(withCb({ fabric: 111855.2 }, 121543.2))
    expect(c.diff).toBe(-9688)
  })
  it('无成本桶的历史单不参与校验(不误报)', () => {
    expect(checkCostConsistency({ total_cost: 999, items: [] }).checkable).toBe(false)
    expect(checkCostConsistency({ total_cost: 999 }).checkable).toBe(false)
  })
  it('一分钱以内不算不一致(浮点容差)', () => {
    expect(checkCostConsistency(withCb({ fabric: 100 }, 100.005)).consistent).toBe(true)
  })
})

describe('getCostBreakdown', () => {
  it('从 items[0] 取载体', () => {
    expect(getCostBreakdown([{ _cost_breakdown: { fabric: 1 } }])).toEqual({ fabric: 1 })
    expect(getCostBreakdown([{ sku: 'A' }])).toBeNull()
    expect(getCostBreakdown(null)).toBeNull()
  })
})
