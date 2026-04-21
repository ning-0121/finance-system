'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  CreditCard, AlertTriangle, Clock, CheckCircle, Search, TrendingDown, Loader2, Download,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { getPayableRecords } from '@/lib/supabase/queries-v2'
import Link from 'next/link'
import type { PayableRecord } from '@/lib/types'
import { toast } from 'sonner'

// ---------- 账龄分桶 ----------
const agingBuckets = [
  { name: '0-30天', range: [0, 30] as [number, number], color: '#22c55e' },
  { name: '31-60天', range: [31, 60] as [number, number], color: '#f59e0b' },
  { name: '61-90天', range: [61, 90] as [number, number], color: '#ef4444' },
  { name: '90天+', range: [91, Infinity] as [number, number], color: '#991b1b' },
]

type APRow = {
  id: string
  orderNo: string
  supplier: string
  description: string
  currency: string
  amount: number
  paidAmount: number
  balance: number
  dueDate: string | null
  paymentStatus: string
  overBudget: boolean
  agingDays: number
  status: 'paid' | 'partial' | 'unpaid' | 'overdue'
}

const COST_CATEGORY_LABELS: Record<string, string> = {
  raw_material: '面料/原料', factory: '加工费', freight: '运费',
  commission: '佣金', tax: '税务', other: '其他',
}

function buildAPRows(records: PayableRecord[]): APRow[] {
  const now = new Date()
  return records.map(r => {
    const dueDate = r.due_date ? new Date(r.due_date) : null
    const isPastDue = dueDate ? now > dueDate : false
    const agingDays = isPastDue && dueDate
      ? Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0

    const paidAmount = r.paid_amount || 0
    const balance = r.amount - paidAmount

    let status: APRow['status'] = 'unpaid'
    if (paidAmount >= r.amount) status = 'paid'
    else if (paidAmount > 0) status = 'partial'
    else if (isPastDue) status = 'overdue'

    return {
      id: r.id,
      orderNo: r.order_no || '-',
      supplier: r.supplier_name,
      description: r.description,
      currency: r.currency,
      amount: r.amount,
      paidAmount,
      balance,
      dueDate: r.due_date,
      paymentStatus: r.payment_status,
      overBudget: r.over_budget,
      agingDays,
      status,
    }
  })
}

function downloadCSV(rows: APRow[]) {
  const headers = ['供应商', '订单号', '描述', '货币', '应付金额', '已付金额', '余额', '到期日', '账龄(天)', '状态']
  const statusLabel: Record<string, string> = { paid: '已付', partial: '部分付', unpaid: '未付', overdue: '逾期' }
  const lines = rows.map(r => [
    r.supplier, r.orderNo, r.description, r.currency,
    r.amount, r.paidAmount, r.balance,
    r.dueDate || '', r.agingDays, statusLabel[r.status] || r.status,
  ].join(','))
  const csv = [headers.join(','), ...lines].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `AP账龄报表_${new Date().toISOString().substring(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
  toast.success('CSV已下载')
}

export default function PayablesPage() {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('all')
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<APRow[]>([])

  useEffect(() => {
    async function load() {
      try {
        const records = await getPayableRecords()
        setRows(buildAPRows(records))
      } catch { /* empty */ }
      setLoading(false)
    }
    load()
  }, [])

  const unpaid = rows.filter(r => r.status !== 'paid')
  const overdue = rows.filter(r => r.status === 'overdue')
  const totalBalance = unpaid.reduce((s, r) => s + r.balance, 0)
  const overdueBalance = overdue.reduce((s, r) => s + r.balance, 0)
  const overBudgetCount = rows.filter(r => r.overBudget && r.status !== 'paid').length
  const payRate = rows.length > 0
    ? Math.round((rows.filter(r => r.status === 'paid').length / rows.length) * 100)
    : 0

  const agingData = agingBuckets.map(bucket => {
    const items = unpaid.filter(r => r.agingDays >= bucket.range[0] && r.agingDays <= bucket.range[1])
    return {
      name: bucket.name,
      amount: items.reduce((s, r) => s + r.balance, 0),
      color: bucket.color,
      count: items.length,
    }
  })

  const filtered = rows.filter(r => {
    const matchTab = tab === 'all' || r.status === tab
    const matchSearch = !search
      || r.supplier.toLowerCase().includes(search.toLowerCase())
      || r.orderNo.toLowerCase().includes(search.toLowerCase())
      || r.description.toLowerCase().includes(search.toLowerCase())
    return matchTab && matchSearch
  })

  const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
    paid: { label: '已付', variant: 'default' },
    partial: { label: '部分付', variant: 'secondary' },
    unpaid: { label: '未付', variant: 'outline' },
    overdue: { label: '逾期', variant: 'destructive' },
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="应付账款管理" subtitle="基于决算确认自动生成 · 账龄追踪 · 付款控制" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-50"><CreditCard className="h-4 w-4 text-blue-600" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">应付总额</p>
                  <p className="text-xl font-bold">¥{totalBalance.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className={overdueBalance > 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${overdueBalance > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <AlertTriangle className={`h-4 w-4 ${overdueBalance > 0 ? 'text-red-600' : 'text-gray-400'}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">逾期应付</p>
                  <p className={`text-xl font-bold ${overdueBalance > 0 ? 'text-red-600' : ''}`}>
                    ¥{overdueBalance.toLocaleString()}
                  </p>
                  <p className="text-xs text-muted-foreground">{overdue.length} 笔</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className={overBudgetCount > 0 ? 'border-amber-200' : ''}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${overBudgetCount > 0 ? 'bg-amber-50' : 'bg-gray-50'}`}>
                  <TrendingDown className={`h-4 w-4 ${overBudgetCount > 0 ? 'text-amber-600' : 'text-gray-400'}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">超预算笔数</p>
                  <p className={`text-xl font-bold ${overBudgetCount > 0 ? 'text-amber-600' : ''}`}>
                    {overBudgetCount}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-50"><CheckCircle className="h-4 w-4 text-green-600" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">付款率</p>
                  <p className="text-xl font-bold text-green-600">{payRate}%</p>
                  <p className="text-xs text-muted-foreground">{rows.filter(r => r.status === 'paid').length}/{rows.length} 笔</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 账龄分布图 */}
        {unpaid.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">账龄分布（未付款）</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={agingData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `¥${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v) => [`¥${Number(v).toLocaleString()}`, '应付金额']} />
                  <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                    {agingData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-3 mt-2">
                {agingData.map(b => (
                  <div key={b.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: b.color }} />
                    {b.name}: {b.count} 笔 · ¥{b.amount.toLocaleString()}
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
            <Input
              placeholder="搜索供应商 / 订单号..."
              className="pl-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="all">全部 ({rows.length})</TabsTrigger>
              <TabsTrigger value="overdue">逾期 ({overdue.length})</TabsTrigger>
              <TabsTrigger value="unpaid">未付</TabsTrigger>
              <TabsTrigger value="partial">部分付</TabsTrigger>
              <TabsTrigger value="paid">已付</TabsTrigger>
            </TabsList>
          </Tabs>

          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => downloadCSV(filtered)}
          >
            <Download className="h-4 w-4 mr-1" />
            导出CSV
          </Button>
        </div>

        {/* 明细表格 */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {filtered.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <Clock className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p>{rows.length === 0 ? '暂无应付记录' : '无匹配记录'}</p>
                {rows.length === 0 && (
                  <p className="text-xs mt-1">
                    确认订单决算后自动生成应付记录，或前往{' '}
                    <Link href="/orders" className="text-blue-500 underline">订单管理</Link>
                  </p>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>供应商</TableHead>
                    <TableHead>订单号</TableHead>
                    <TableHead>描述</TableHead>
                    <TableHead className="text-right">应付金额</TableHead>
                    <TableHead className="text-right">余额</TableHead>
                    <TableHead>到期日</TableHead>
                    <TableHead>账龄</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(r => {
                    const cfg = statusConfig[r.status]
                    return (
                      <TableRow key={r.id} className={r.overBudget ? 'bg-amber-50/30' : ''}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-1.5">
                            {r.supplier}
                            {r.overBudget && (
                              <Badge variant="outline" className="text-[9px] text-amber-600 border-amber-400 px-1 py-0">超预算</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {r.orderNo !== '-' ? (
                            <Link href={`/orders/${r.orderNo}`} className="text-blue-500 hover:underline text-sm">
                              {r.orderNo}
                            </Link>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">{r.description}</TableCell>
                        <TableCell className="text-right font-medium">
                          {r.currency} {r.amount.toLocaleString()}
                        </TableCell>
                        <TableCell className={`text-right font-semibold ${r.balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                          {r.balance > 0 ? `${r.currency} ${r.balance.toLocaleString()}` : '已结清'}
                        </TableCell>
                        <TableCell className={`text-sm ${r.status === 'overdue' ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>
                          {r.dueDate || '—'}
                        </TableCell>
                        <TableCell>
                          {r.agingDays > 0 ? (
                            <span className={`text-xs font-medium ${r.agingDays > 90 ? 'text-red-700' : r.agingDays > 60 ? 'text-red-500' : r.agingDays > 30 ? 'text-amber-600' : 'text-muted-foreground'}`}>
                              {r.agingDays}天
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">未到期</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={cfg.variant}>{cfg.label}</Badge>
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
