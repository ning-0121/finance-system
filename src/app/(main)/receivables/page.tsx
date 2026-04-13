'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DollarSign, AlertTriangle, Clock, CheckCircle, Search, TrendingDown, Loader2,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { getBudgetOrders } from '@/lib/supabase/queries'
import Link from 'next/link'
import type { BudgetOrder } from '@/lib/types'

type ReceivableRow = {
  id: string
  customer: string
  country: string
  orderNo: string
  currency: string
  amount: number
  paid: number
  balance: number
  orderDate: string
  dueDate: string
  status: 'paid' | 'partial' | 'unpaid' | 'overdue'
  agingDays: number
}

const agingBuckets = [
  { name: '0-30天', range: [0, 30], color: '#22c55e' },
  { name: '31-60天', range: [31, 60], color: '#f59e0b' },
  { name: '61-90天', range: [61, 90], color: '#ef4444' },
  { name: '90天+', range: [91, Infinity], color: '#991b1b' },
]

function buildReceivables(orders: BudgetOrder[]): ReceivableRow[] {
  const now = new Date()
  return orders
    .filter(o => {
      // 只有已审批和已关闭的订单才算应收
      if (o.status !== 'approved' && o.status !== 'closed') return false
      // 金额为0的不显示
      if (!o.total_revenue || o.total_revenue <= 0) return false
      return true
    })
    .map(o => {
      // 交货日期后30天为应收到期日
      const deliveryDate = o.delivery_date ? new Date(o.delivery_date) : new Date(o.order_date)
      const dueDate = new Date(deliveryDate)
      dueDate.setDate(dueDate.getDate() + 30)

      const isPastDue = now > dueDate
      const agingDays = isPastDue ? Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)) : 0

      // 已关闭的订单视为已收款
      const paid = o.status === 'closed' ? o.total_revenue : 0
      const balance = o.total_revenue - paid
      let status: ReceivableRow['status'] = 'unpaid'
      if (paid >= o.total_revenue) status = 'paid'
      else if (paid > 0) status = 'partial'
      else if (isPastDue) status = 'overdue'

      return {
        id: o.id,
        customer: o.customer?.company || '-',
        country: o.customer?.country || '',
        orderNo: o.order_no,
        currency: o.currency,
        amount: o.total_revenue,
        paid,
        balance,
        orderDate: o.order_date,
        dueDate: dueDate.toISOString().substring(0, 10),
        status,
        agingDays,
      }
    })
}

export default function ReceivablesPage() {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('all')
  const [loading, setLoading] = useState(true)
  const [receivables, setReceivables] = useState<ReceivableRow[]>([])

  useEffect(() => {
    async function load() {
      try {
        const orders = await getBudgetOrders()
        setReceivables(buildReceivables(orders))
      } catch { /* empty */ }
      setLoading(false)
    }
    load()
  }, [])

  const unpaid = receivables.filter(r => r.status !== 'paid')
  const overdue = receivables.filter(r => r.status === 'overdue')
  const totalBalance = unpaid.reduce((s, r) => s + r.balance, 0)
  const overdueBalance = overdue.reduce((s, r) => s + r.balance, 0)

  const agingData = agingBuckets.map(bucket => {
    const items = unpaid.filter(r => r.agingDays >= bucket.range[0] && r.agingDays <= bucket.range[1])
    return { name: bucket.name, amount: items.reduce((s, r) => s + r.balance, 0), color: bucket.color, count: items.length }
  })

  const filtered = receivables.filter(r => {
    const matchTab = tab === 'all' || r.status === tab
    const matchSearch = !search || r.customer.toLowerCase().includes(search.toLowerCase()) || r.orderNo.toLowerCase().includes(search.toLowerCase())
    return matchTab && matchSearch
  })

  const statusConfig = {
    paid: { label: '已收', variant: 'default' as const },
    partial: { label: '部分收', variant: 'secondary' as const },
    unpaid: { label: '未收', variant: 'outline' as const },
    overdue: { label: '逾期', variant: 'destructive' as const },
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="应收账款管理" subtitle="基于已审批订单自动生成 · 账龄追踪 · 回款监控" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-50"><DollarSign className="h-4 w-4 text-blue-600" /></div>
                <div><p className="text-xs text-muted-foreground">应收总额</p><p className="text-xl font-bold">¥{totalBalance.toLocaleString()}</p></div>
              </div>
            </CardContent>
          </Card>
          <Card className={overdueBalance > 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-red-50"><AlertTriangle className="h-4 w-4 text-red-600" /></div>
                <div><p className="text-xs text-muted-foreground">逾期金额</p><p className="text-xl font-bold text-red-600">¥{overdueBalance.toLocaleString()}</p></div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-50"><Clock className="h-4 w-4 text-amber-600" /></div>
                <div><p className="text-xs text-muted-foreground">逾期笔数</p><p className="text-xl font-bold">{overdue.length}</p></div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-50"><TrendingDown className="h-4 w-4 text-green-600" /></div>
                <div><p className="text-xs text-muted-foreground">已收回比率</p><p className="text-xl font-bold">{receivables.length > 0 ? Math.round(receivables.filter(r => r.status === 'paid').length / receivables.length * 100) : 0}%</p></div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Aging Chart */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">账龄分布</CardTitle></CardHeader>
          <CardContent>
            {unpaid.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={agingData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={v => `¥${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(value) => [`¥${Number(value).toLocaleString()}`, '金额']} />
                  <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                    {agingData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-center text-muted-foreground py-8">暂无未收款项</p>
            )}
          </CardContent>
        </Card>

        {/* Table */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="all">全部 ({receivables.length})</TabsTrigger>
              <TabsTrigger value="overdue" className={overdue.length > 0 ? 'text-red-600' : ''}>逾期 ({overdue.length})</TabsTrigger>
              <TabsTrigger value="unpaid">未收 ({receivables.filter(r => r.status === 'unpaid').length})</TabsTrigger>
              <TabsTrigger value="paid">已收 ({receivables.filter(r => r.status === 'paid').length})</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="搜索客户/订单号..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead>关联订单</TableHead>
                  <TableHead className="text-right">订单金额</TableHead>
                  <TableHead className="text-right">已收</TableHead>
                  <TableHead className="text-right">余额</TableHead>
                  <TableHead>到期日</TableHead>
                  <TableHead>账龄</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(r => {
                  const sc = statusConfig[r.status]
                  return (
                    <TableRow key={r.id} className={r.status === 'overdue' ? 'bg-red-50/50' : ''}>
                      <TableCell>
                        <div><p className="text-sm font-medium">{r.customer}</p><p className="text-xs text-muted-foreground">{r.country}</p></div>
                      </TableCell>
                      <TableCell>
                        <Link href={`/orders/${r.id}`} className="text-primary text-sm hover:underline">{r.orderNo}</Link>
                      </TableCell>
                      <TableCell className="text-right">{r.currency} {r.amount.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-green-600">{r.currency} {r.paid.toLocaleString()}</TableCell>
                      <TableCell className={`text-right font-semibold ${r.balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {r.currency} {r.balance.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">{r.dueDate}</TableCell>
                      <TableCell>
                        {r.agingDays > 0 ? (
                          <span className={`text-sm font-medium ${r.agingDays > 60 ? 'text-red-700' : r.agingDays > 30 ? 'text-amber-700' : 'text-green-700'}`}>
                            {r.agingDays}天
                          </span>
                        ) : '-'}
                      </TableCell>
                      <TableCell><Badge variant={sc.variant}>{sc.label}</Badge></TableCell>
                    </TableRow>
                  )
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                      {receivables.length === 0 ? '暂无已审批订单，应收数据将在订单审批通过后自动生成' : '没有匹配的记录'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
