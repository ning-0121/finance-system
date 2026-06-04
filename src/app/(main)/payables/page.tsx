'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  CreditCard, AlertTriangle, Clock, CheckCircle, Search, Loader2, Download,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { createClient } from '@/lib/supabase/client'
import { getSupplierPayments } from '@/lib/supabase/queries-v2'
import { normalizeSupplierName } from '@/lib/utils'
import Link from 'next/link'
import { toast } from 'sonner'

// ============================================================
// 应付账款 = 费用归集中「未付」的费用，按供应商汇总 + 账龄
// 账龄按费用录入日(created_at)计算（cost_items 无到期日）。
// 在「费用归集」勾选「已付款」后，这里会自动减少。
// 付款执行仍在「付款（出纳）」模块，互不冲突。
// ============================================================

const agingBuckets = [
  { name: '0-30天', range: [0, 30] as [number, number], color: '#22c55e' },
  { name: '31-60天', range: [31, 60] as [number, number], color: '#f59e0b' },
  { name: '61-90天', range: [61, 90] as [number, number], color: '#ef4444' },
  { name: '90天+', range: [91, Infinity] as [number, number], color: '#991b1b' },
]

interface CostRow {
  id: string
  supplier: string
  description: string
  cost_type: string
  amountCny: number
  orderLabel: string
  createdAt: string
  agingDays: number
}

interface SupplierAP {
  supplier: string
  chargeCount: number
  totalChargeCny: number
  paidCny: number       // 已登记付款合计（与供应商对账单口径一致）
  unpaidCny: number     // = 费用合计 − 付款合计
  orders: string[]
  oldestAging: number   // FIFO：最早一笔未被付款冲抵的费用账龄
  items: CostRow[]      // 该供应商全部费用（按日期升序）
}

function daysSince(dateStr: string): number {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)))
}

export default function PayablesPage() {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('unpaid')
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<CostRow[]>([])
  const [paidBySupplier, setPaidBySupplier] = useState<Record<string, number>>({})

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const supabase = createClient()
        const [costRes, syncedRes, payList] = await Promise.all([
          supabase
            .from('cost_items')
            .select('id, description, amount, currency, exchange_rate, supplier, cost_type, budget_order_id, created_at, budget_orders(order_no)')
            .is('deleted_at', null)
            .order('created_at', { ascending: true }),
          supabase.from('synced_orders').select('budget_order_id, order_no, style_no').not('budget_order_id', 'is', null),
          getSupplierPayments(),
        ])

        const syncMap = new Map<string, string>()
        ;(syncedRes.data || []).forEach((s: Record<string, unknown>) => {
          if (s.budget_order_id) {
            const internal = s.style_no ? `${s.style_no} | ` : ''
            syncMap.set(s.budget_order_id as string, `${internal}${(s.order_no as string) || ''}`)
          }
        })

        const list: CostRow[] = (costRes.data || []).map((c: Record<string, unknown>) => {
          const boId = c.budget_order_id as string | null
          const bo = c.budget_orders as { order_no?: string } | null
          const orderLabel = boId ? (syncMap.get(boId) || bo?.order_no || '') : ''
          const amt = Number(c.amount) || 0
          const rate = Number(c.exchange_rate) || 1
          return {
            id: c.id as string,
            supplier: normalizeSupplierName(c.supplier as string) || '未指定供应商',
            description: (c.description as string) || '',
            cost_type: (c.cost_type as string) || '',
            amountCny: Math.round(amt * rate * 100) / 100,
            orderLabel,
            createdAt: c.created_at as string,
            agingDays: daysSince(c.created_at as string),
          }
        })
        const payMap: Record<string, number> = {}
        payList.forEach(p => { const k = normalizeSupplierName(p.supplier_name) || '未指定供应商'; payMap[k] = (payMap[k] || 0) + (Number(p.amount) || 0) })
        setRows(list)
        setPaidBySupplier(payMap)
      } catch (err) {
        console.error('加载应付失败:', err)
        toast.error('加载失败')
      }
      setLoading(false)
    }
    load()
  }, [])

  // 按供应商聚合：未付 = 费用合计 − 已登记付款（与供应商对账单一致）
  const suppliers = useMemo<SupplierAP[]>(() => {
    const map = new Map<string, SupplierAP>()
    for (const r of rows) {
      let s = map.get(r.supplier)
      if (!s) {
        s = { supplier: r.supplier, chargeCount: 0, totalChargeCny: 0, paidCny: 0, unpaidCny: 0, orders: [], oldestAging: 0, items: [] }
        map.set(r.supplier, s)
      }
      s.chargeCount += 1
      s.totalChargeCny += r.amountCny
      s.items.push(r)
      if (r.orderLabel && !s.orders.includes(r.orderLabel)) s.orders.push(r.orderLabel)
    }
    // 只有付款、没有费用的供应商也纳入（显示为多付/预付）
    for (const sup of Object.keys(paidBySupplier)) {
      if (!map.has(sup)) map.set(sup, { supplier: sup, chargeCount: 0, totalChargeCny: 0, paidCny: 0, unpaidCny: 0, orders: [], oldestAging: 0, items: [] })
    }
    return Array.from(map.values())
      .map(s => {
        const paid = paidBySupplier[s.supplier] || 0
        const unpaid = s.totalChargeCny - paid
        // FIFO 账龄：付款先冲抵最早的费用，找出第一笔未被完全冲抵的费用
        let remaining = paid
        let oldestAging = 0
        for (const c of s.items) {  // items 已按日期升序
          if (remaining >= c.amountCny) { remaining -= c.amountCny; continue }
          oldestAging = c.agingDays
          break
        }
        return {
          ...s,
          paidCny: Math.round(paid * 100) / 100,
          totalChargeCny: Math.round(s.totalChargeCny * 100) / 100,
          unpaidCny: Math.round(unpaid * 100) / 100,
          oldestAging,
        }
      })
      .sort((a, b) => b.unpaidCny - a.unpaidCny)
  }, [rows, paidBySupplier])

  const hasUnpaid = (s: SupplierAP) => s.unpaidCny > 0.005
  const withUnpaid = suppliers.filter(hasUnpaid)
  const totalUnpaid = withUnpaid.reduce((s, r) => s + r.unpaidCny, 0)
  const totalPaid = suppliers.reduce((s, r) => s + r.paidCny, 0)
  const overdue60 = withUnpaid.filter(s => s.oldestAging > 60)
  const overdue60Amount = overdue60.reduce((s, r) => s + r.unpaidCny, 0)

  const agingData = agingBuckets.map(bucket => {
    const items = withUnpaid.filter(s => s.oldestAging >= bucket.range[0] && s.oldestAging <= bucket.range[1])
    return { name: bucket.name, amount: items.reduce((s, r) => s + r.unpaidCny, 0), color: bucket.color, count: items.length }
  })

  const filtered = useMemo(() => {
    let base = suppliers
    if (tab === 'unpaid') base = suppliers.filter(hasUnpaid)
    else if (tab === 'overdue') base = suppliers.filter(s => s.oldestAging > 60 && hasUnpaid(s))
    else if (tab === 'cleared') base = suppliers.filter(s => !hasUnpaid(s) && (s.paidCny > 0 || s.totalChargeCny > 0))
    if (search) base = base.filter(s => s.supplier.toLowerCase().includes(search.toLowerCase()))
    return base
  }, [suppliers, tab, search])

  const exportCsv = () => {
    const headers = ['供应商', '费用笔数', '费用合计(¥)', '已付(¥)', '未付(¥)', '最长账龄(天)', '关联订单']
    const lines = filtered.map(s => [
      s.supplier, s.chargeCount, s.totalChargeCny, s.paidCny, s.unpaidCny, s.oldestAging,
      `"${s.orders.join(' / ')}"`,
    ].join(','))
    const csv = [headers.join(','), ...lines].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `应付账款_未付汇总_${new Date().toISOString().substring(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('CSV已下载')
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="应付账款管理" subtitle="费用归集（应付）− 已登记付款 = 实际未付 · 与供应商对账单同口径 · 在对账单「登记付款」后自动减少" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50"><CreditCard className="h-4 w-4 text-blue-600" /></div>
              <div><p className="text-xs text-muted-foreground">应付总额（未付）</p><p className="text-xl font-bold">¥{totalUnpaid.toLocaleString()}</p></div>
            </CardContent>
          </Card>
          <Card className={overdue60Amount > 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`p-2 rounded-lg ${overdue60Amount > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                <AlertTriangle className={`h-4 w-4 ${overdue60Amount > 0 ? 'text-red-600' : 'text-gray-400'}`} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">超60天应付</p>
                <p className={`text-xl font-bold ${overdue60Amount > 0 ? 'text-red-600' : ''}`}>¥{overdue60Amount.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">{overdue60.length} 个供应商</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-50"><Clock className="h-4 w-4 text-amber-600" /></div>
              <div><p className="text-xs text-muted-foreground">待付供应商</p><p className="text-xl font-bold">{withUnpaid.length}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-50"><CheckCircle className="h-4 w-4 text-green-600" /></div>
              <div><p className="text-xs text-muted-foreground">已付累计</p><p className="text-xl font-bold text-green-600">¥{totalPaid.toLocaleString()}</p></div>
            </CardContent>
          </Card>
        </div>

        {/* 账龄分布 */}
        {withUnpaid.length > 0 && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">账龄分布（按最长未付费用 · 录入日起算）</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={agingData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `¥${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v) => [`¥${Number(v).toLocaleString()}`, '未付金额']} />
                  <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                    {agingData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-3 mt-2">
                {agingData.map(b => (
                  <div key={b.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: b.color }} />
                    {b.name}: {b.count} 个供应商 · ¥{b.amount.toLocaleString()}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 过滤栏 */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="搜索供应商..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="unpaid">待付 ({withUnpaid.length})</TabsTrigger>
              <TabsTrigger value="overdue">超60天 ({overdue60.length})</TabsTrigger>
              <TabsTrigger value="cleared">已付清</TabsTrigger>
              <TabsTrigger value="all">全部 ({suppliers.length})</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" className="ml-auto" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="h-4 w-4 mr-1" />导出CSV
          </Button>
        </div>

        {/* 明细表格 */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {filtered.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <Clock className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>{rows.length === 0 ? '暂无费用记录' : '当前筛选下无供应商'}</p>
                <p className="text-xs mt-1">
                  应付 = {' '}
                  <Link href="/costs" className="text-blue-500 underline">费用归集</Link>
                  {' '}的费用 − 在供应商对账单「登记付款」的金额
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>供应商</TableHead>
                    <TableHead className="text-center">费用笔数</TableHead>
                    <TableHead className="text-right">费用合计(¥)</TableHead>
                    <TableHead className="text-right">已付(¥)</TableHead>
                    <TableHead className="text-right">未付(¥)</TableHead>
                    <TableHead>关联订单</TableHead>
                    <TableHead>最长账龄</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(s => {
                    const unpaidShown = hasUnpaid(s)
                    return (
                      <React.Fragment key={s.supplier}>
                        <TableRow
                          className={`cursor-pointer hover:bg-muted/50 ${s.oldestAging > 60 && unpaidShown ? 'bg-red-50/40' : ''}`}
                          onClick={() => { window.location.href = `/payables/${encodeURIComponent(s.supplier)}` }}
                        >
                          <TableCell className="font-medium text-primary hover:underline">
                            {s.supplier}
                            <span className="ml-1 text-[10px] text-muted-foreground">查看明细 →</span>
                          </TableCell>
                          <TableCell className="text-center">{s.chargeCount}</TableCell>
                          <TableCell className="text-right text-sm">¥{s.totalChargeCny.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-sm text-green-600">¥{s.paidCny.toLocaleString()}</TableCell>
                          <TableCell className={`text-right font-semibold ${unpaidShown ? 'text-red-600' : 'text-green-600'}`}>
                            {unpaidShown ? `¥${s.unpaidCny.toLocaleString()}` : (s.unpaidCny < -0.005 ? `多付 ¥${Math.abs(s.unpaidCny).toLocaleString()}` : '已结清')}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1 flex-wrap">
                              {s.orders.slice(0, 3).map(o => <Badge key={o} variant="outline" className="text-[10px]">{o}</Badge>)}
                              {s.orders.length > 3 && <span className="text-[10px] text-muted-foreground">+{s.orders.length - 3}</span>}
                            </div>
                          </TableCell>
                          <TableCell>
                            {unpaidShown ? (
                              <span className={`text-xs font-medium ${s.oldestAging > 90 ? 'text-red-700' : s.oldestAging > 60 ? 'text-red-500' : s.oldestAging > 30 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                                {s.oldestAging}天
                              </span>
                            ) : <span className="text-xs text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell>
                            <Badge variant={!unpaidShown ? 'default' : 'secondary'} className={!unpaidShown ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}>
                              {!unpaidShown ? '已付清' : '未付清'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      </React.Fragment>
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
