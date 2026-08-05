'use client'

import { use, useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { ArrowLeft, Loader2, Download, ExternalLink } from 'lucide-react'
import { getBudgetOrders } from '@/lib/supabase/queries'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { summarizeCustomers, type RawOrder } from '@/lib/financial/customer-summary'
import { recentPeriods, ALL_TIME, type Granularity, type PeriodRange } from '@/lib/financial/period'

const GRANS: { key: Granularity; label: string }[] = [
  { key: 'month', label: '按月' }, { key: 'quarter', label: '按季' }, { key: 'year', label: '按年' },
]

export default function CustomerDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: raw } = use(params)
  const name = decodeURIComponent(raw)
  const sp = useSearchParams()

  const [orders, setOrders] = useState<RawOrder[]>([])
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [gran, setGran] = useState<Granularity>((sp.get('g') as Granularity) || 'month')
  const [periodKey, setPeriodKey] = useState<string>(sp.get('p') || 'all')

  useEffect(() => {
    async function load() {
      try {
        setOrders((await getBudgetOrders()) as unknown as RawOrder[])
        const sb = createClient()
        const { data } = await fetchAll<{ budget_order_id: string; quantity: number | null }>((from, to) =>
          sb.from('synced_orders').select('budget_order_id, quantity')
            .not('budget_order_id', 'is', null).order('budget_order_id').range(from, to))
        const m: Record<string, number> = {}
        for (const s of data || []) if (s.budget_order_id) m[s.budget_order_id] = (m[s.budget_order_id] || 0) + (Number(s.quantity) || 0)
        setQtyMap(m)
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

  const cust = useMemo(
    () => summarizeCustomers(orders, period, quantityOf).find(c => c.name === name) || null,
    [orders, period, quantityOf, name])

  function exportCsv() {
    if (!cust) return
    const head = ['订单号', '内部单号', '下单日期', '状态', '币种', '汇率', '合同金额(原币)', '收入(CNY)', '成本(CNY)', '利润(CNY)', '利润率(%)', '件数', '备注']
    const rows = cust.orders.map(o => [o.orderNo, o.internalNo || '', o.orderDate || '', o.status, o.currency,
      o.exchangeRate ?? '', o.revenueOriginal, o.missingRate ? '' : o.revenueCny, o.costCny,
      o.missingRate ? '' : o.profitCny, o.missingRate ? '' : o.marginPct, o.quantity,
      o.missingRate ? '缺汇率，金额未计入合计' : ''])
    const csv = [head, ...rows].map(r => r.map(v => {
      const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }))
    a.download = `${name}_订单明细_${period.label}.csv`
    a.click()
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title={name} subtitle={`客户财务档案 · ${period.label}`} />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        <div className="flex flex-wrap items-center gap-2">
          <Link href="/profiles/customers">
            <Button variant="ghost" size="sm" className="gap-1.5"><ArrowLeft className="h-4 w-4" />返回客户列表</Button>
          </Link>
          <div className="inline-flex rounded-lg border overflow-hidden ml-auto">
            {GRANS.map(g => (
              <button key={g.key} onClick={() => { setGran(g.key); setPeriodKey('all') }}
                className={`px-3 py-1.5 text-sm transition-colors ${gran === g.key ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'}`}>
                {g.label}
              </button>
            ))}
          </div>
          <select value={periodKey} onChange={e => setPeriodKey(e.target.value)} aria-label="选择统计周期"
            className="h-9 rounded-lg border bg-background px-3 text-sm">
            {periods.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={exportCsv} disabled={!cust}>
            <Download className="h-4 w-4" />导出明细
          </Button>
        </div>

        {!cust ? (
          <Card><CardContent className="p-12 text-center text-muted-foreground">
            {period.label}内，该客户没有已通过的订单。换个周期试试。
          </CardContent></Card>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <Card><CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">订单个数</p>
                <p className="text-2xl font-bold tabular-nums">{cust.orderCount}</p></CardContent></Card>
              <Card><CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">订单总件数</p>
                <p className="text-2xl font-bold tabular-nums">{cust.totalQuantity.toLocaleString()}</p></CardContent></Card>
              <Card><CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">订单总额 (CNY)</p>
                <p className="text-2xl font-bold tabular-nums">¥{Math.round(cust.totalRevenueCny).toLocaleString()}</p></CardContent></Card>
              <Card><CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">订单总利润 (CNY)</p>
                <p className={`text-2xl font-bold tabular-nums ${cust.totalProfitCny < 0 ? 'text-red-600' : 'text-green-600'}`}>
                  ¥{Math.round(cust.totalProfitCny).toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">成本 ¥{Math.round(cust.totalCostCny).toLocaleString()}</p></CardContent></Card>
              <Card><CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">平均利润率</p>
                <p className={`text-2xl font-bold tabular-nums ${cust.avgMarginPct < 0 ? 'text-red-600' : cust.avgMarginPct < 15 ? 'text-amber-600' : 'text-green-600'}`}>
                  {cust.avgMarginPct}%</p>
                <p className="text-xs text-muted-foreground">加权：总利润÷总收入</p></CardContent></Card>
            </div>

            {cust.excludedMissingRate > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                该客户有 <strong>{cust.excludedMissingRate}</strong> 张外币订单未填结汇汇率，
                其金额<strong>未计入</strong>上方合计（件数与订单数已计）。下表中以「缺汇率」标出。
              </div>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  订单明细
                  <span className="text-sm font-normal text-muted-foreground ml-2">共 {cust.orders.length} 张 · 点订单号进详情</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>订单号</TableHead>
                      <TableHead>下单日期</TableHead>
                      <TableHead className="text-right">合同金额</TableHead>
                      <TableHead className="text-right">收入 (CNY)</TableHead>
                      <TableHead className="text-right">成本 (CNY)</TableHead>
                      <TableHead className="text-right">利润 (CNY)</TableHead>
                      <TableHead className="text-right">利润率</TableHead>
                      <TableHead className="text-right">件数</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cust.orders.map(o => (
                      <TableRow key={o.id} className={o.missingRate ? 'bg-amber-50/50' : 'hover:bg-muted/40'}>
                        <TableCell>
                          <Link href={`/orders/${o.id}`} className="font-medium hover:text-primary hover:underline">
                            {o.orderNo || '(无单号)'}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {o.internalNo || ''} {o.status === 'closed' && <Badge variant="outline" className="ml-1 text-[10px]">已关闭</Badge>}
                          </p>
                        </TableCell>
                        <TableCell className="text-sm">{o.orderDate || '—'}</TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {o.currency === 'CNY' ? '¥' : '$'}{o.revenueOriginal.toLocaleString()}
                          {o.currency !== 'CNY' && o.exchangeRate ? <span className="text-xs text-muted-foreground"> @{o.exchangeRate}</span> : null}
                        </TableCell>
                        {o.missingRate ? (
                          <>
                            <TableCell className="text-right" colSpan={2}>
                              <span className="text-xs text-amber-700 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5">缺汇率 · 未计入合计</span>
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">—</TableCell>
                            <TableCell className="text-right text-muted-foreground">—</TableCell>
                          </>
                        ) : (
                          <>
                            <TableCell className="text-right tabular-nums">¥{Math.round(o.revenueCny).toLocaleString()}</TableCell>
                            <TableCell className="text-right tabular-nums">¥{Math.round(o.costCny).toLocaleString()}</TableCell>
                            <TableCell className={`text-right tabular-nums font-semibold ${o.profitCny < 0 ? 'text-red-600' : 'text-green-600'}`}>
                              ¥{Math.round(o.profitCny).toLocaleString()}</TableCell>
                            <TableCell className="text-right">
                              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                                o.marginPct < 0 ? 'bg-red-100 text-red-700'
                                  : o.marginPct < 15 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                                {o.marginPct}%</span>
                            </TableCell>
                          </>
                        )}
                        <TableCell className="text-right tabular-nums text-sm">{o.quantity ? o.quantity.toLocaleString() : '—'}</TableCell>
                        <TableCell>
                          <Link href={`/orders/${o.id}`} aria-label={`打开订单 ${o.orderNo}`}>
                            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
