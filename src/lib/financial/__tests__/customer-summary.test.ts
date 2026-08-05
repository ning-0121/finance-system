import { describe, it, expect } from 'vitest'
import { summarizeCustomers, totalOf, isCounted } from '../customer-summary'
import { monthRange, ALL_TIME } from '../period'

const o = (p: Partial<Parameters<typeof summarizeCustomers>[0][number]>) => ({
  id: 'x', status: 'approved', currency: 'CNY', order_date: '2026-07-10',
  total_revenue: 0, total_cost: 0, customer: { company: 'A客户', country: 'USA' }, ...p,
})

describe('口径①:只计已通过/已关闭', () => {
  it('草稿与驳回不进客户业绩', () => {
    expect(isCounted('approved')).toBe(true)
    expect(isCounted('closed')).toBe(true)
    expect(isCounted('draft')).toBe(false)
    expect(isCounted('rejected')).toBe(false)
    const r = summarizeCustomers([
      o({ id: '1', status: 'approved', total_revenue: 100 }),
      o({ id: '2', status: 'draft', total_revenue: 900 }),
    ], ALL_TIME)
    expect(r[0].orderCount).toBe(1)
    expect(r[0].totalRevenueCny).toBe(100)
  })
})

describe('口径②:先折汇再相加', () => {
  it('不同汇率的两单必须各折各的', () => {
    const r = summarizeCustomers([
      o({ id: '1', currency: 'USD', exchange_rate: 7, total_revenue: 100, total_cost: 200 }),
      o({ id: '2', currency: 'USD', exchange_rate: 6, total_revenue: 100, total_cost: 100 }),
    ], ALL_TIME)
    expect(r[0].totalRevenueCny).toBe(1300)     // 700 + 600,不是 200×某个汇率
    expect(r[0].totalCostCny).toBe(300)
    expect(r[0].totalProfitCny).toBe(1000)
  })
  it('人民币单直取', () => {
    const r = summarizeCustomers([o({ currency: 'CNY', total_revenue: 500, total_cost: 300 })], ALL_TIME)
    expect(r[0].totalProfitCny).toBe(200)
  })
})

describe('口径③:外币缺汇率不硬算', () => {
  it('缺率单不计入金额合计,但要报出被排除的单数', () => {
    const r = summarizeCustomers([
      o({ id: '1', currency: 'USD', exchange_rate: 7, total_revenue: 100, total_cost: 0 }),
      o({ id: '2', currency: 'USD', exchange_rate: null, total_revenue: 9999, total_cost: 0 }),
    ], ALL_TIME)
    expect(r[0].totalRevenueCny).toBe(700)      // 绝不是 700 + 9999×7
    expect(r[0].excludedMissingRate).toBe(1)
    expect(r[0].orderCount).toBe(2)             // 单数仍计,只是金额没算进去
    expect(r[0].orders.find(x => x.id === '2')!.missingRate).toBe(true)
  })
  it('缺率单的件数照计(件数与汇率无关)', () => {
    const r = summarizeCustomers(
      [o({ id: '2', currency: 'USD', exchange_rate: null, total_revenue: 100 })],
      ALL_TIME, () => 3000)
    expect(r[0].totalQuantity).toBe(3000)
    expect(r[0].totalRevenueCny).toBe(0)
  })
})

describe('周期过滤', () => {
  it('只统计落在周期内的订单', () => {
    const jul = monthRange(2026, 7)
    const r = summarizeCustomers([
      o({ id: '1', order_date: '2026-07-01', total_revenue: 100 }),
      o({ id: '2', order_date: '2026-06-30', total_revenue: 900 }),
      o({ id: '3', order_date: '2026-08-01', total_revenue: 900 }),
    ], jul)
    expect(r[0].orderCount).toBe(1)
    expect(r[0].totalRevenueCny).toBe(100)
  })
  it('无下单日期的单不静默算进当期', () => {
    const r = summarizeCustomers([o({ id: '1', order_date: null, total_revenue: 100 })], monthRange(2026, 7))
    expect(r.length).toBe(0)
  })
  it('全部时间不过滤', () => {
    const r = summarizeCustomers([
      o({ id: '1', order_date: '2019-01-01', total_revenue: 100 }),
      o({ id: '2', order_date: '2026-07-01', total_revenue: 100 }),
    ], ALL_TIME)
    expect(r[0].orderCount).toBe(2)
  })
})

describe('平均利润率用加权,不用算术平均', () => {
  it('大单应主导平均利润率', () => {
    const r = summarizeCustomers([
      o({ id: 'big', total_revenue: 1_000_000, total_cost: 900_000 }),   // 10%
      o({ id: 'sml', total_revenue: 100, total_cost: 0 }),               // 100%
    ], ALL_TIME)
    // 加权 = 100100/1000100 ≈ 10.01%;算术平均会是 55%,严重失真
    expect(r[0].avgMarginPct).toBeCloseTo(10.01, 1)
    expect(r[0].avgMarginPct).toBeLessThan(11)
  })
})

describe('件数与合计', () => {
  it('件数由调用方注入并累加', () => {
    const qty: Record<string, number> = { '1': 1200, '2': 800 }
    const r = summarizeCustomers([o({ id: '1' }), o({ id: '2' })], ALL_TIME, id => qty[id] || 0)
    expect(r[0].totalQuantity).toBe(2000)
  })
  it('totalOf 汇总多客户', () => {
    const r = summarizeCustomers([
      o({ id: '1', customer: { company: 'A' }, total_revenue: 1000, total_cost: 600 }),
      o({ id: '2', customer: { company: 'B' }, total_revenue: 500, total_cost: 400 }),
    ], ALL_TIME)
    const t = totalOf(r)
    expect(t.customers).toBe(2)
    expect(t.revenue).toBe(1500)
    expect(t.profit).toBe(500)
    expect(t.marginPct).toBeCloseTo(33.33, 1)
  })
})
