import { describe, it, expect } from 'vitest'
import { monthRange, quarterRange, yearRange, lunarYearRange, periodOf, recentPeriods, inPeriod, ALL_TIME, isAllTime } from '../period'

describe('周期区间', () => {
  it('月:含首尾,月末日正确', () => {
    expect(monthRange(2026, 2)).toMatchObject({ key: '2026-02', start: '2026-02-01', end: '2026-02-28' })
    expect(monthRange(2024, 2).end).toBe('2024-02-29')   // 闰年
    expect(monthRange(2026, 7)).toMatchObject({ label: '2026年7月', end: '2026-07-31' })
  })
  it('季:跨三个月', () => {
    expect(quarterRange(2026, 3)).toMatchObject({ key: '2026-Q3', label: '2026年三季度', start: '2026-07-01', end: '2026-09-30' })
    expect(quarterRange(2026, 1).start).toBe('2026-01-01')
    expect(quarterRange(2026, 4).end).toBe('2026-12-31')
  })
  it('年', () => {
    expect(yearRange(2026)).toMatchObject({ start: '2026-01-01', end: '2026-12-31', label: '2026年' })
  })
})

describe('periodOf —— 定位某日所在周期', () => {
  it('按给定日期定位', () => {
    expect(periodOf('month', '2026-08-04').key).toBe('2026-08')
    expect(periodOf('quarter', '2026-08-04').key).toBe('2026-Q3')
    expect(periodOf('year', '2026-08-04').key).toBe('2026')
  })
  it('季度边界:3月底属Q1,4月初属Q2', () => {
    expect(periodOf('quarter', '2026-03-31').key).toBe('2026-Q1')
    expect(periodOf('quarter', '2026-04-01').key).toBe('2026-Q2')
  })
})

describe('recentPeriods —— 最近 n 期,最新在前,可跨年', () => {
  it('月:跨年回溯', () => {
    const p = recentPeriods('month', 3, '2026-01-15').map(x => x.key)
    expect(p).toEqual(['2026-01', '2025-12', '2025-11'])
  })
  it('季:跨年回溯', () => {
    const p = recentPeriods('quarter', 3, '2026-02-10').map(x => x.key)
    expect(p).toEqual(['2026-Q1', '2025-Q4', '2025-Q3'])
  })
  it('年', () => {
    expect(recentPeriods('year', 3, '2026-08-04').map(x => x.key)).toEqual(['2026', '2025', '2024'])
  })
  it('不产生未来周期', () => {
    const p = recentPeriods('month', 5, '2026-08-04')
    expect(p[0].key).toBe('2026-08')
    expect(p.every(x => x.start <= '2026-08-31')).toBe(true)
  })
})

describe('inPeriod', () => {
  const jul = monthRange(2026, 7)
  it('含首尾', () => {
    expect(inPeriod('2026-07-01', jul)).toBe(true)
    expect(inPeriod('2026-07-31', jul)).toBe(true)
  })
  it('区间外', () => {
    expect(inPeriod('2026-06-30', jul)).toBe(false)
    expect(inPeriod('2026-08-01', jul)).toBe(false)
  })
  it('接受 ISO 时间戳(只取日期部分)', () => {
    expect(inPeriod('2026-07-15T23:59:59+08:00', jul)).toBe(true)
  })
  it('空日期不落入任何周期(不静默算进当期)', () => {
    expect(inPeriod(null, jul)).toBe(false)
    expect(inPeriod(undefined, jul)).toBe(false)
    expect(inPeriod('', jul)).toBe(false)
  })
})

describe('全时段哨兵', () => {
  it('任何日期都落入', () => {
    expect(isAllTime(ALL_TIME)).toBe(true)
    expect(inPeriod('2019-01-01', ALL_TIME)).toBe(true)
    expect(inPeriod('2099-12-31', ALL_TIME)).toBe(true)
  })
})

describe('农历年度(老板口径:春节起算)', () => {
  it('2026 农历年度 = 2026-02-17 至 2027-02-05', () => {
    const p = lunarYearRange(2026)
    expect(p.start).toBe('2026-02-17')
    expect(p.end).toBe('2027-02-05')      // 下一个春节前一日
    expect(p.key).toBe('L2026')
    expect(p.label).toContain('2026-02-17')
  })
  it('春节【前】的日期属于上一个农历年度', () => {
    expect(periodOf('lunar_year', '2026-02-16').key).toBe('L2025')
    expect(periodOf('lunar_year', '2026-02-17').key).toBe('L2026')
    expect(periodOf('lunar_year', '2026-01-05').key).toBe('L2025')
  })
  it('年前年后的单不会被算进同一年度', () => {
    const y25 = lunarYearRange(2025), y26 = lunarYearRange(2026)
    expect(inPeriod('2026-02-16', y25)).toBe(true)
    expect(inPeriod('2026-02-16', y26)).toBe(false)
    expect(inPeriod('2026-02-17', y26)).toBe(true)
  })
  it('最近 n 个农历年度可回溯', () => {
    expect(recentPeriods('lunar_year', 3, '2026-08-04').map(x => x.key)).toEqual(['L2026', 'L2025', 'L2024'])
  })
  it('超出查表范围退回自然年,不猜农历日期', () => {
    expect(lunarYearRange(2050).granularity).toBe('year')
  })
})
