/**
 * 会计/经营周期工具(2026-08-04)
 *
 * 月 / 季 / 年 三种粒度的区间与标签,供客户财务档案、经营报表共用。
 * 全部按【业务时区 Asia/Shanghai】切分 —— 服务器是 UTC,直接用 getMonth() 会让
 * 北京时间月初 0~8 点落到上个月(与 lib/biz-date 同源的坑,GL 期间已踩过)。
 */
import { bizToday } from '@/lib/biz-date'

export type Granularity = 'month' | 'quarter' | 'year'

export interface PeriodRange {
  key: string        // 排序/去重键:2026-07 / 2026-Q3 / 2026
  label: string      // 展示:2026年7月 / 2026年三季度 / 2026年
  start: string      // YYYY-MM-DD(含)
  end: string        // YYYY-MM-DD(含)
  granularity: Granularity
}

const QUARTER_CN = ['一', '二', '三', '四']
const pad = (n: number) => String(n).padStart(2, '0')
/** 该年月的最后一天(day=0 取上月末,故传 m+1) */
const lastDay = (y: number, m1: number) => new Date(Date.UTC(y, m1, 0)).getUTCDate()

export function monthRange(y: number, m1: number): PeriodRange {
  return {
    key: `${y}-${pad(m1)}`, label: `${y}年${m1}月`,
    start: `${y}-${pad(m1)}-01`, end: `${y}-${pad(m1)}-${pad(lastDay(y, m1))}`,
    granularity: 'month',
  }
}

export function quarterRange(y: number, q: number): PeriodRange {
  const m1 = (q - 1) * 3 + 1, m2 = m1 + 2
  return {
    key: `${y}-Q${q}`, label: `${y}年${QUARTER_CN[q - 1]}季度`,
    start: `${y}-${pad(m1)}-01`, end: `${y}-${pad(m2)}-${pad(lastDay(y, m2))}`,
    granularity: 'quarter',
  }
}

export function yearRange(y: number): PeriodRange {
  return { key: `${y}`, label: `${y}年`, start: `${y}-01-01`, end: `${y}-12-31`, granularity: 'year' }
}

/** 含 date 的那个周期(date 缺省=业务今天) */
export function periodOf(granularity: Granularity, date?: string): PeriodRange {
  const d = date || bizToday()
  const y = Number(d.slice(0, 4)), m1 = Number(d.slice(5, 7))
  if (granularity === 'year') return yearRange(y)
  if (granularity === 'quarter') return quarterRange(y, Math.floor((m1 - 1) / 3) + 1)
  return monthRange(y, m1)
}

/**
 * 最近 n 个周期(倒序:最新在前),用于报表的周期下拉与趋势。
 * 不做"未来周期"——按业务今天所在周期往回数。
 */
export function recentPeriods(granularity: Granularity, n: number, date?: string): PeriodRange[] {
  const cur = periodOf(granularity, date)
  const y = Number(cur.key.slice(0, 4))
  const out: PeriodRange[] = []
  if (granularity === 'year') {
    for (let i = 0; i < n; i++) out.push(yearRange(y - i))
  } else if (granularity === 'quarter') {
    let q = Number(cur.key.slice(-1)), yy = y
    for (let i = 0; i < n; i++) { out.push(quarterRange(yy, q)); q--; if (q === 0) { q = 4; yy-- } }
  } else {
    let m = Number(cur.key.slice(5, 7)), yy = y
    for (let i = 0; i < n; i++) { out.push(monthRange(yy, m)); m--; if (m === 0) { m = 12; yy-- } }
  }
  return out
}

/** 日期(YYYY-MM-DD 或 ISO)是否落在区间内(含首尾)。空日期一律不落入任何周期。 */
export function inPeriod(date: string | null | undefined, p: PeriodRange): boolean {
  if (!date) return false
  const d = String(date).slice(0, 10)
  return d >= p.start && d <= p.end
}

/** 全时段哨兵:UI 上的「全部」选项,不做日期过滤 */
export const ALL_TIME: PeriodRange = {
  key: 'all', label: '全部时间', start: '0000-01-01', end: '9999-12-31', granularity: 'year',
}
export const isAllTime = (p: PeriodRange) => p.key === 'all'
