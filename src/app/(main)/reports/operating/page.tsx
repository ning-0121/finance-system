'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import Link from 'next/link'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Loader2, Download, ArrowLeft, TrendingUp, TrendingDown } from 'lucide-react'
import { getBudgetOrders } from '@/lib/supabase/queries'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { metricsFor, seriesFor, changePct, type RawOrderWithItems } from '@/lib/financial/operating-report'
import { buildBenchmark } from '@/lib/financial/cost-benchmark'
import { recentPeriods, type Granularity } from '@/lib/financial/period'
import { COST_BUCKETS } from '@/lib/financial/cost-breakdown'

const GRANS: { key: Granularity; label: string }[] = [
  { key: 'month', label: '按月' }, { key: 'quarter', label: '按季' }, { key: 'year', label: '按年' },
]
const yuan = (n: number) => `¥${Math.round(n).toLocaleString()}`

function Delta({ v }: { v: number | null }) {
  if (v == null) return <span className="text-xs text-muted-foreground">—</span>
  const up = v >= 0
  return (
    <span className={`text-xs inline-flex items-center gap-0.5 ${up ? 'text-green-600' : 'text-red-600'}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{Math.abs(v)}%
    </span>
  )
}

export default function OperatingReportPage() {
  const [orders, setOrders] = useState<RawOrderWithItems[]>([])
  const [qtyMap, setQtyMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [gran, setGran] = useState<Granularity>('month')

  useEffect(() => {
    async function load() {
      try {
        setOrders((await getBudgetOrders()) as unknown as RawOrderWithItems[])
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

  const quantityOf = useCallback((id: string) => qtyMap[id] || 0, [qtyMap])
  const periods = useMemo(
    () => recentPeriods(gran, gran === 'year' ? 4 : gran === 'quarter' ? 8 : 12),
    [gran])
  // recentPeriods 最新在前;趋势表按时间正序更好读
  const series = useMemo(() => seriesFor(orders, [...periods].reverse(), quantityOf), [orders, periods, quantityOf])
  const cur = series[series.length - 1]
  const prev = series[series.length - 2]
  const bench = useMemo(
    () => buildBenchmark(orders, periods[0], quantityOf),
    [orders, periods, quantityOf])

  function exportCsv() {
    const head = ['周期', '订单数', '件数', '客户数', '收入(CNY)', '成本(CNY)', '利润(CNY)', '毛利率(%)', '单件收入', '单件成本', '缺汇率未计入']
    const rows = series.map(m => [m.period.label, m.orderCount, m.quantity, m.customerCount,
      m.revenueCny, m.costCny, m.profitCny, m.marginPct, m.revenuePerPc, m.costPerPc, m.excludedMissingRate])
    const csv = [head, ...rows].map(r => r.map(v => {
      const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }))
    a.download = `经营报表_${GRANS.find(g => g.key === gran)?.label}_${cur?.period.label || ''}.csv`
    a.click()
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const maxRev = Math.max(...series.map(s => s.revenueCny), 1)
  const bucketTotal = cur ? Object.values(cur.buckets).reduce((a, b) => a + b, 0) : 0

  return (
    <div className="flex flex-col h-full">
      <Header title="经营报表" subtitle="按月 / 季 / 年看收入、成本、利润、订单量 · 经营口径" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        <div className="flex flex-wrap items-center gap-2">
          <Link href="/reports"><Button variant="ghost" size="sm" className="gap-1.5"><ArrowLeft className="h-4 w-4" />汇总报表</Button></Link>
          <div className="inline-flex rounded-lg border overflow-hidden ml-auto">
            {GRANS.map(g => (
              <button key={g.key} onClick={() => setGran(g.key)}
                className={`px-3 py-1.5 text-sm transition-colors ${gran === g.key ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'}`}>
                {g.label}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={exportCsv}>
            <Download className="h-4 w-4" />导出
          </Button>
        </div>

        {/* 本期 KPI + 环比 */}
        <div>
          <p className="text-sm text-muted-foreground mb-2">
            本期：<span className="font-medium text-foreground">{cur?.period.label}</span>
            {prev && <span className="ml-2 text-xs">环比 {prev.period.label}</span>}
          </p>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
            {[
              { k: '收入 (CNY)', v: yuan(cur?.revenueCny || 0), d: changePct(cur?.revenueCny || 0, prev?.revenueCny) },
              { k: '成本 (CNY)', v: yuan(cur?.costCny || 0), d: changePct(cur?.costCny || 0, prev?.costCny) },
              { k: '利润 (CNY)', v: yuan(cur?.profitCny || 0), d: changePct(cur?.profitCny || 0, prev?.profitCny), hl: (cur?.profitCny || 0) < 0 },
              { k: '毛利率', v: `${cur?.marginPct || 0}%`, d: null },
              { k: '订单数', v: String(cur?.orderCount || 0), d: changePct(cur?.orderCount || 0, prev?.orderCount) },
              { k: '件数', v: (cur?.quantity || 0).toLocaleString(), d: changePct(cur?.quantity || 0, prev?.quantity) },
            ].map(x => (
              <Card key={x.k}><CardContent className="p-4">
                <p className="text-xs text-muted-foreground mb-1">{x.k}</p>
                <p className={`text-xl font-bold tabular-nums ${x.hl ? 'text-red-600' : ''}`}>{x.v}</p>
                <div className="mt-1"><Delta v={x.d} /></div>
              </CardContent></Card>
            ))}
          </div>
        </div>

        {cur && cur.excludedMissingRate > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            本期有 <strong>{cur.excludedMissingRate}</strong> 张外币订单缺结汇汇率，金额未计入 —— 补汇率后数字才完整。
          </div>
        )}

        {/* 趋势 */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">趋势</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>周期</TableHead>
                <TableHead className="text-right">订单数</TableHead>
                <TableHead className="text-right">件数</TableHead>
                <TableHead className="text-right">收入 (CNY)</TableHead>
                <TableHead className="text-right">利润 (CNY)</TableHead>
                <TableHead className="text-right">毛利率</TableHead>
                <TableHead className="text-right">单件收入</TableHead>
                <TableHead className="text-right">单件成本</TableHead>
                <TableHead className="w-32">收入占比</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {[...series].reverse().map(m => (
                  <TableRow key={m.period.key} className={m.period.key === cur?.period.key ? 'bg-primary/5' : ''}>
                    <TableCell className="text-sm font-medium">{m.period.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.orderCount || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.quantity ? m.quantity.toLocaleString() : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.revenueCny ? yuan(m.revenueCny) : '—'}</TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${m.profitCny < 0 ? 'text-red-600' : m.profitCny > 0 ? 'text-green-600' : ''}`}>
                      {m.profitCny ? yuan(m.profitCny) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{m.revenueCny ? `${m.marginPct}%` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{m.revenuePerPc ? `¥${m.revenuePerPc}` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{m.costPerPc ? `¥${m.costPerPc}` : '—'}</TableCell>
                    <TableCell>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-primary/60" style={{ width: `${Math.round(m.revenueCny / maxRev * 100)}%` }} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* 成本结构 */}
        {bucketTotal > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">本期成本结构<span className="text-sm font-normal text-muted-foreground ml-2">{cur?.period.label}</span></CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
              {[...COST_BUCKETS.map(b => ({ key: b.key as string, label: b.label as string })),
                { key: 'extras', label: '其他费用' }]
                .map(b => ({ ...b, v: cur?.buckets[b.key] || 0 }))
                .filter(b => b.v > 0)
                .sort((a, b) => b.v - a.v)
                .map(b => (
                  <div key={b.key} className="flex items-center gap-3 text-sm">
                    <span className="w-20 shrink-0 text-muted-foreground">{b.label}</span>
                    <div className="flex-1 h-4 rounded bg-muted overflow-hidden">
                      <div className="h-full bg-primary/50" style={{ width: `${Math.round(b.v / bucketTotal * 100)}%` }} />
                    </div>
                    <span className="w-28 text-right tabular-nums">{yuan(b.v)}</span>
                    <span className="w-12 text-right tabular-nums text-xs text-muted-foreground">
                      {Math.round(b.v / bucketTotal * 100)}%</span>
                  </div>
                ))}
            </CardContent>
          </Card>
        )}

        {/* 成本基准:单件化对比,规则可解释 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">成本基准（单件）</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              把成本按件数单件化后再比 —— 不同订单件数差几十倍，总额没有可比性。
              用<strong>中位数</strong>而非平均数作基准：服装订单成本长尾明显，一张异常单就能把平均数拉走。
            </p>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>成本项</TableHead>
                <TableHead className="text-right">样本单数</TableHead>
                <TableHead className="text-right">最低</TableHead>
                <TableHead className="text-right">25 分位</TableHead>
                <TableHead className="text-right">中位数</TableHead>
                <TableHead className="text-right">75 分位</TableHead>
                <TableHead className="text-right">最高</TableHead>
                <TableHead>可靠性</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {bench.map(b => (
                  <TableRow key={b.group}>
                    <TableCell className="font-medium text-sm">{b.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.n}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{b.n ? `¥${b.min}` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{b.n ? `¥${b.p25}` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">{b.n ? `¥${b.median}` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{b.n ? `¥${b.p75}` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{b.n ? `¥${b.max}` : '—'}</TableCell>
                    <TableCell>
                      {b.n === 0
                        ? <span className="text-xs text-muted-foreground">无样本</span>
                        : b.reliable
                          ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">可作基准</span>
                          : <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">样本不足</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          <strong>经营口径</strong>：按订单下单日期归期，取自订单成本核算数据，只计已通过 / 已关闭的订单。
          与总账的<strong>利润表</strong>口径不同（后者按已过账凭证与权责发生制归期），两者天然不等，不是数据错误。
        </p>
      </div>
    </div>
  )
}
