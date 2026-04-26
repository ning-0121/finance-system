'use client'

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  TrendingUp, TrendingDown, AlertTriangle, DollarSign, Users,
  Search, Download, RefreshCw, Loader2, ChevronRight, BarChart2,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Cell, LineChart, Line, ReferenceLine,
} from 'recharts'
import Link from 'next/link'
import { toast } from 'sonner'
import { RISK_CONFIG, type MarginRisk } from '@/lib/profit-calculator'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface ProfitOrder {
  id: string
  order_no: string
  order_date: string
  status: string
  currency: string
  exchange_rate: number
  computed_profit_usd: number
  computed_margin: number
  computed_sales_usd: number
  computed_cost_usd: number
  risk_status: MarginRisk
  customer: { id: string; company: string; country: string | null } | null
}

interface Summary {
  count: number
  total_sales_usd: number
  total_profit_usd: number
  avg_margin: number
  critical_count: number
  warning_count: number
  healthy_count: number
}

// ─────────────────────────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────────────────────────

function exportCSV(orders: ProfitOrder[]) {
  const headers = ['订单号', '客户', '日期', '状态', '销售额(USD)', '成本(USD)', '毛利(USD)', '毛利率%', '汇率', '风险']
  const statusLabel: Record<string, string> = { draft: '草稿', approved: '已审', closed: '已关', pending_review: '待审' }
  const riskLabel: Record<MarginRisk, string> = { critical: '风险', warning: '预警', healthy: '健康' }
  const rows = orders.map(o => [
    o.order_no,
    o.customer?.company || '-',
    o.order_date,
    statusLabel[o.status] || o.status,
    o.computed_sales_usd.toFixed(2),
    o.computed_cost_usd.toFixed(2),
    o.computed_profit_usd.toFixed(2),
    o.computed_margin.toFixed(2),
    o.exchange_rate,
    riskLabel[o.risk_status],
  ].join(','))
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url
  a.download = `利润控制_${new Date().toISOString().slice(0, 10)}.csv`; a.click()
  URL.revokeObjectURL(url)
  toast.success('CSV 已导出')
}

// ─────────────────────────────────────────────────────────────
// Margin bar distribution
// ─────────────────────────────────────────────────────────────

function buildMarginBuckets(orders: ProfitOrder[]) {
  const buckets = [
    { name: '<10%', range: [-Infinity, 10], color: '#ef4444' },
    { name: '10–15%', range: [10, 15], color: '#f59e0b' },
    { name: '15–20%', range: [15, 20], color: '#22c55e' },
    { name: '>20%', range: [20, Infinity], color: '#16a34a' },
  ]
  return buckets.map(b => ({
    name: b.name,
    count: orders.filter(o => o.computed_margin >= b.range[0] && o.computed_margin < b.range[1]).length,
    color: b.color,
  }))
}

// ─────────────────────────────────────────────────────────────
// Page Component
// ─────────────────────────────────────────────────────────────

export default function ProfitControlPage() {
  const [orders, setOrders] = useState<ProfitOrder[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [riskTab, setRiskTab] = useState('all')
  const [fxRate, setFxRate] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ordersRes, fxRes] = await Promise.all([
        fetch('/api/profit/orders?limit=300'),
        fetch('/api/profit/fx'),
      ])
      const ordersData = await ordersRes.json()
      if (!ordersRes.ok) throw new Error(ordersData.error)
      setOrders(ordersData.orders || [])
      setSummary(ordersData.summary)

      if (fxRes.ok) {
        const fxData = await fxRes.json()
        setFxRate(fxData.current_rate)
      }
    } catch (e) {
      toast.error(`加载失败: ${e instanceof Error ? e.message : '未知'}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Filter
  const filtered = orders.filter(o => {
    const matchRisk = riskTab === 'all' || o.risk_status === riskTab
    const matchSearch = !search
      || o.order_no.toLowerCase().includes(search.toLowerCase())
      || (o.customer?.company || '').toLowerCase().includes(search.toLowerCase())
    return matchRisk && matchSearch
  })

  const marginBuckets = buildMarginBuckets(orders)

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <Header title="利润控制中心" subtitle="订单利润 · 客户分析 · 成本拆解 · 汇率模拟" />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="利润控制中心" subtitle="订单利润 · 客户分析 · 成本拆解 · 汇率模拟" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* ── KPI Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <DollarSign className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">总销售额</p>
                  <p className="text-lg font-bold">${((summary?.total_sales_usd || 0) / 1000).toFixed(0)}k</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <TrendingUp className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">总毛利</p>
                  <p className="text-lg font-bold text-green-600">${((summary?.total_profit_usd || 0) / 1000).toFixed(0)}k</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <BarChart2 className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">平均毛利率</p>
                  <p className={`text-lg font-bold ${(summary?.avg_margin || 0) >= 15 ? 'text-green-600' : (summary?.avg_margin || 0) >= 10 ? 'text-amber-600' : 'text-red-600'}`}>
                    {(summary?.avg_margin || 0).toFixed(1)}%
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className={(summary?.critical_count || 0) > 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className={`h-4 w-4 mt-0.5 shrink-0 ${(summary?.critical_count || 0) > 0 ? 'text-red-600' : 'text-muted-foreground'}`} />
                <div>
                  <p className="text-xs text-muted-foreground">低利润订单</p>
                  <p className={`text-lg font-bold ${(summary?.critical_count || 0) > 0 ? 'text-red-600' : ''}`}>
                    {summary?.critical_count || 0}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <Users className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">订单数</p>
                  <p className="text-lg font-bold">{summary?.count || 0}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-2">
                <TrendingDown className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs text-muted-foreground">当前汇率</p>
                  <p className="text-lg font-bold text-blue-600">{fxRate ? fxRate.toFixed(2) : '—'}</p>
                  <p className="text-[10px] text-muted-foreground">USD/CNY</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Two-column: margin distribution + quick links ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">毛利率分布</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={marginBuckets} margin={{ top: 5, right: 10, left: -15, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip formatter={(v) => [`${v} 笔`, '订单数']} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {marginBuckets.map((b, i) => <Cell key={i} fill={b.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">快速导航</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Link href="/profit-control/customers">
                <div className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-blue-600" />
                    <span className="text-sm">客户利润分析</span>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </div>
              </Link>
              <div
                className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                onClick={() => exportCSV(filtered)}
              >
                <div className="flex items-center gap-2">
                  <Download className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">导出当前列表</span>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="border-t pt-2 mt-2 text-xs text-muted-foreground space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> 毛利率 &lt;10% = 风险
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> 10–15% = 预警
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> ≥15% = 健康
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Order Profit Table ── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center gap-3">
              <CardTitle className="text-base">订单利润明细</CardTitle>
              <div className="relative flex-1 min-w-[180px] max-w-xs ml-auto">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  className="pl-8 h-8 text-sm"
                  placeholder="搜索订单号 / 客户..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <Button variant="ghost" size="sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
              <Button variant="outline" size="sm" onClick={() => exportCSV(filtered)}>
                <Download className="h-4 w-4 mr-1" />导出
              </Button>
            </div>
            <Tabs value={riskTab} onValueChange={setRiskTab} className="mt-2">
              <TabsList>
                <TabsTrigger value="all">全部 ({orders.length})</TabsTrigger>
                <TabsTrigger value="critical" className="text-red-600">
                  风险 ({summary?.critical_count || 0})
                </TabsTrigger>
                <TabsTrigger value="warning" className="text-amber-600">
                  预警 ({summary?.warning_count || 0})
                </TabsTrigger>
                <TabsTrigger value="healthy" className="text-green-600">
                  健康 ({summary?.healthy_count || 0})
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {filtered.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">
                {orders.length === 0 ? '暂无已审批订单' : '无匹配结果'}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead className="w-36">订单号</TableHead>
                    <TableHead>客户</TableHead>
                    <TableHead className="text-right">销售额 (USD)</TableHead>
                    <TableHead className="text-right">成本 (USD)</TableHead>
                    <TableHead className="text-right">毛利 (USD)</TableHead>
                    <TableHead className="text-right">毛利率</TableHead>
                    <TableHead className="text-center">汇率</TableHead>
                    <TableHead className="text-center">状态</TableHead>
                    <TableHead className="text-center w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(order => {
                    const rc = RISK_CONFIG[order.risk_status]
                    return (
                      <TableRow key={order.id} className={order.risk_status === 'critical' ? 'bg-red-50/40' : ''}>
                        <TableCell className="font-mono text-sm font-medium">{order.order_no}</TableCell>
                        <TableCell className="text-sm">{order.customer?.company || '—'}</TableCell>
                        <TableCell className="text-right font-medium">${order.computed_sales_usd.toLocaleString('en', { maximumFractionDigits: 0 })}</TableCell>
                        <TableCell className="text-right text-muted-foreground">${order.computed_cost_usd.toLocaleString('en', { maximumFractionDigits: 0 })}</TableCell>
                        <TableCell className={`text-right font-semibold ${order.computed_profit_usd >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {order.computed_profit_usd >= 0 ? '+' : ''}${order.computed_profit_usd.toLocaleString('en', { maximumFractionDigits: 0 })}
                        </TableCell>
                        <TableCell className="text-right">
                          <span className={`text-sm font-bold ${rc.color}`}>
                            {order.computed_margin.toFixed(1)}%
                          </span>
                        </TableCell>
                        <TableCell className="text-center text-xs text-muted-foreground">{order.exchange_rate?.toFixed(2) || '—'}</TableCell>
                        <TableCell className="text-center">
                          <Badge variant={rc.badge} className="text-[10px]">{rc.label}</Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <Link href={`/profit-control/${order.id}`}>
                            <Button size="sm" variant="ghost" className="h-7 px-2">
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
