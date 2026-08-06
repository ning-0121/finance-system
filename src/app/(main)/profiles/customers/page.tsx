'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Search, Loader2, ChevronRight, Download } from 'lucide-react'
import { getOrderFinancials, toRawOrders, quantityMapOf } from '@/lib/supabase/order-financials'
import { summarizeCustomers, totalOf, type CustomerSummary, type RawOrder } from '@/lib/financial/customer-summary'
import { recentPeriods, ALL_TIME, type Granularity, type PeriodRange } from '@/lib/financial/period'

const GRANS: { key: Granularity; label: string }[] = [
  { key: 'month', label: '按月' }, { key: 'quarter', label: '按季' }, { key: 'year', label: '按年' },
]

export default function CustomerProfilesPage() {
  const [orders, setOrders] = useState<RawOrder[]>([])
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({})
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [gran, setGran] = useState<Granularity>('month')
  const [periodKey, setPeriodKey] = useState<string>('all')

  useEffect(() => {
    async function load() {
      try {
        // 改从视图 v_order_financials 取:件数、成本桶均已在库里算好,
        // 不必再拉 budget_orders 全量 + 单独查 synced_orders 件数(原先两趟)。
        const rows = await getOrderFinancials()
        setOrders(toRawOrders(rows) as unknown as RawOrder[])
        setQtyMap(quantityMapOf(rows))
      } catch { /* 保持空态,不伪造数据 */ }
      setLoading(false)
    }
    load()
  }, [])

  const periods = useMemo<PeriodRange[]>(
    () => [ALL_TIME, ...recentPeriods(gran, gran === 'year' ? 4 : gran === 'quarter' ? 8 : 12)],
    [gran])
  const period = periods.find(p => p.key === periodKey) || ALL_TIME

  const quantityOf = useCallback((id: string) => qtyMap[id] || 0, [qtyMap])
  const customers = useMemo(
    () => summarizeCustomers(orders, period, quantityOf),
    [orders, period, quantityOf])

  const filtered = customers.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()))
  const t = totalOf(filtered)

  function exportCsv() {
    const head = ['客户', '国家', '订单个数', '订单总件数', '订单总额(CNY)', '总成本(CNY)', '总利润(CNY)', '平均利润率(%)', '缺汇率未计入']
    const rows = filtered.map(c => [c.name, c.country, c.orderCount, c.totalQuantity,
      c.totalRevenueCny, c.totalCostCny, c.totalProfitCny, c.avgMarginPct, c.excludedMissingRate])
    const csv = [head, ...rows].map(r => r.map(v => {
      const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }))
    a.download = `客户财务档案_${period.label}.csv`
    a.click()
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="客户财务档案" subtitle="按周期统计每个客户的订单量、金额与利润 · 可下钻到单张订单" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* 周期选择 */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border overflow-hidden">
            {GRANS.map(g => (
              <button key={g.key}
                onClick={() => { setGran(g.key); setPeriodKey('all') }}
                className={`px-3 py-1.5 text-sm transition-colors ${gran === g.key ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'}`}>
                {g.label}
              </button>
            ))}
          </div>
          <select value={periodKey} onChange={e => setPeriodKey(e.target.value)}
            aria-label="选择统计周期"
            className="h-9 rounded-lg border bg-background px-3 text-sm">
            {periods.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8 h-9" placeholder="搜索客户…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 ml-auto" onClick={exportCsv}>
            <Download className="h-4 w-4" />导出
          </Button>
        </div>

        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">客户数</p>
            <p className="text-2xl font-bold tabular-nums">{t.customers}</p></CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">订单个数</p>
            <p className="text-2xl font-bold tabular-nums">{t.orderCount}</p></CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">订单总件数</p>
            <p className="text-2xl font-bold tabular-nums">{t.quantity.toLocaleString()}</p></CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">订单总额 (CNY)</p>
            <p className="text-2xl font-bold tabular-nums">¥{Math.round(t.revenue).toLocaleString()}</p></CardContent></Card>
          <Card><CardContent className="p-4">
            <p className="text-xs text-muted-foreground mb-1">总利润 / 平均利润率</p>
            <p className={`text-2xl font-bold tabular-nums ${t.profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
              ¥{Math.round(t.profit).toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">{t.marginPct}%</p></CardContent></Card>
        </div>

        {/* 缺汇率诚实提示:不能让合计"看着对、其实少" */}
        {t.excluded > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            有 <strong>{t.excluded}</strong> 张外币订单未填结汇汇率，其金额<strong>未计入</strong>上方合计（件数与订单数已计）。
            系统不会用猜测的汇率替你折算 —— 请进订单补汇率后数字才完整。
          </div>
        )}

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead className="text-right">订单个数</TableHead>
                  <TableHead className="text-right">订单总件数</TableHead>
                  <TableHead className="text-right">订单总额 (CNY)</TableHead>
                  <TableHead className="text-right">总利润 (CNY)</TableHead>
                  <TableHead className="text-right">平均利润率</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                    {period.key === 'all' ? '暂无已通过的订单' : `${period.label}没有已通过的订单`}
                  </TableCell></TableRow>
                )}
                {filtered.map(c => (
                  <TableRow key={c.name} className="hover:bg-muted/40">
                    <TableCell>
                      <Link href={`/profiles/customers/${encodeURIComponent(c.name)}?g=${gran}&p=${periodKey}`}
                        className="font-medium hover:text-primary hover:underline">{c.name}</Link>
                      <p className="text-xs text-muted-foreground">{c.country}</p>
                      {c.excludedMissingRate > 0 && (
                        <span className="text-[10px] text-amber-700">{c.excludedMissingRate} 单缺汇率未计金额</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.orderCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.totalQuantity.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">¥{Math.round(c.totalRevenueCny).toLocaleString()}</TableCell>
                    <TableCell className={`text-right tabular-nums font-semibold ${c.totalProfitCny < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      ¥{Math.round(c.totalProfitCny).toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                        c.avgMarginPct < 0 ? 'bg-red-100 text-red-700'
                          : c.avgMarginPct < 15 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                        {c.avgMarginPct}%</span>
                    </TableCell>
                    <TableCell>
                      <Link href={`/profiles/customers/${encodeURIComponent(c.name)}?g=${gran}&p=${periodKey}`}
                        aria-label={`查看 ${c.name} 明细`}>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          口径：只统计<strong>已通过 / 已关闭</strong>的订单（草稿与驳回单不计入客户业绩）；
          收入按各订单自身汇率折人民币后再合计；平均利润率 = 总利润 ÷ 总收入（加权）。
        </p>
      </div>
    </div>
  )
}

export type { CustomerSummary }
