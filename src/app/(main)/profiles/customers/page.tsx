'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Search, Loader2 } from 'lucide-react'
import { getBudgetOrders } from '@/lib/supabase/queries'
import type { BudgetOrder } from '@/lib/types'

type CustomerSummary = {
  name: string
  country: string
  orderCount: number
  totalRevenue: number
  totalCost: number
  totalProfit: number
  avgMargin: number
  currency: string
}

export default function CustomerProfilesPage() {
  const [customers, setCustomers] = useState<CustomerSummary[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const orders = await getBudgetOrders()
        // 按客户聚合
        const map = new Map<string, { orders: BudgetOrder[] }>()
        for (const o of orders) {
          const name = o.customer?.company || '未知客户'
          if (!map.has(name)) map.set(name, { orders: [] })
          map.get(name)!.orders.push(o)
        }
        const summaries: CustomerSummary[] = Array.from(map.entries()).map(([name, { orders: ords }]) => {
          // 全部转CNY口径计算
          const totalRevenueCny = ords.reduce((s, o) => {
            const rate = o.currency === 'CNY' ? 1 : (o.exchange_rate || 7)
            return s + o.total_revenue * rate
          }, 0)
          const totalCost = ords.reduce((s, o) => s + o.total_cost, 0)
          const totalProfit = totalRevenueCny - totalCost
          const avgMargin = totalRevenueCny > 0 ? Math.round(totalProfit / totalRevenueCny * 10000) / 100 : 0
          return {
            name,
            country: ords[0]?.customer?.country || '',
            orderCount: ords.length,
            totalRevenue: Math.round(totalRevenueCny),
            totalCost: Math.round(totalCost),
            totalProfit: Math.round(totalProfit),
            avgMargin,
            currency: 'CNY', // 汇总后统一CNY
          }
        }).sort((a, b) => b.totalRevenue - a.totalRevenue)
        setCustomers(summaries)
      } catch { /* empty */ }
      setLoading(false)
    }
    load()
  }, [])

  const filtered = customers.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()))
  const totalCustomers = customers.length
  const totalRevenue = customers.reduce((s, c) => s + c.totalRevenue, 0)
  const totalProfit = customers.reduce((s, c) => s + c.totalProfit, 0)

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="客户画像" subtitle="基于订单数据自动聚合 · 收入排名 · 利润贡献" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">客户总数</p><p className="text-2xl font-bold">{totalCustomers}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">总收入(CNY)</p><p className="text-2xl font-bold">¥ {totalRevenue.toLocaleString()}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">总利润(CNY)</p><p className="text-2xl font-bold">¥ {totalProfit.toLocaleString()}</p></CardContent></Card>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="搜索客户..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead>国家</TableHead>
                  <TableHead className="text-right">订单数</TableHead>
                  <TableHead className="text-right">总收入(CNY)</TableHead>
                  <TableHead className="text-right">总成本(CNY)</TableHead>
                  <TableHead className="text-right">总利润(CNY)</TableHead>
                  <TableHead className="text-right">平均毛利率</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(c => (
                  <TableRow key={c.name}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.country}</TableCell>
                    <TableCell className="text-right">{c.orderCount}</TableCell>
                    <TableCell className="text-right font-medium">¥ {c.totalRevenue.toLocaleString()}</TableCell>
                    <TableCell className="text-right">¥ {c.totalCost.toLocaleString()}</TableCell>
                    <TableCell className={`text-right font-semibold ${c.totalProfit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      ¥ {c.totalProfit.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        c.avgMargin < 0 ? 'bg-red-100 text-red-700' : c.avgMargin < 15 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                      }`}>{c.avgMargin}%</span>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center py-12 text-muted-foreground">暂无客户数据</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
