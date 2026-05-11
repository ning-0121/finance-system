'use client'

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ChevronLeft, ChevronRight, Download, Loader2,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { BudgetOrder, PayableRecord } from '@/lib/types'
import * as XLSX from 'xlsx'

// ─── Types ────────────────────────────────────────────────────────────────────

type ARRow = {
  id: string
  customer: string
  orderNo: string
  currency: string
  amount: number
  paid: number
  balance: number
  dueDate: string
  status: 'overdue' | 'due_this_week' | 'upcoming'
}

type APRow = {
  id: string
  supplier: string
  orderNo: string
  currency: string
  amount: number
  balance: number
  dueDate: string | null
  plannedAmount: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return Monday of the week containing `date` */
function getWeekMonday(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay() // 0=Sun
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function fmt(d: Date): string {
  return d.toISOString().substring(0, 10)
}

function fmtDisplay(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** Inline buildReceivables logic (from receivables/page.tsx) */
function buildARRows(orders: BudgetOrder[], weekStart: Date, weekEnd: Date): ARRow[] {
  const now = new Date()
  return orders
    .filter(o => {
      if (o.status !== 'approved' && o.status !== 'closed') return false
      if (!o.total_revenue || o.total_revenue <= 0) return false
      return true
    })
    .map(o => {
      const deliveryDate = o.delivery_date ? new Date(o.delivery_date) : new Date(o.order_date)
      const dueDate = new Date(deliveryDate)
      dueDate.setDate(dueDate.getDate() + 30)

      const explicit = o.ar_received_amount != null && !Number.isNaN(Number(o.ar_received_amount))
      const paid = explicit
        ? Math.min(Math.max(0, Number(o.ar_received_amount)), o.total_revenue)
        : (o.status === 'closed' ? o.total_revenue : 0)
      const balance = o.total_revenue - paid

      if (balance <= 0) return null

      const dueDateStr = fmt(dueDate)
      const isPastDue = now > dueDate
      const isDueThisWeek = dueDate >= weekStart && dueDate <= weekEnd

      let status: ARRow['status'] = 'upcoming'
      if (isPastDue) status = 'overdue'
      else if (isDueThisWeek) status = 'due_this_week'

      return {
        id: o.id,
        customer: o.customer?.company || '-',
        orderNo: o.order_no,
        currency: o.currency,
        amount: o.total_revenue,
        paid,
        balance,
        dueDate: dueDateStr,
        status,
      } satisfies ARRow
    })
    .filter((r): r is ARRow => r !== null)
}

function buildAPRows(records: PayableRecord[]): APRow[] {
  return records
    .filter(r => r.payment_status !== 'paid' && r.payment_status !== 'cancelled')
    .map(r => {
      const paidAmount = r.paid_amount || 0
      const balance = r.amount - paidAmount
      if (balance <= 0) return null
      return {
        id: r.id,
        supplier: r.supplier_name,
        orderNo: r.order_no || '-',
        currency: r.currency,
        amount: r.amount,
        balance,
        dueDate: r.due_date,
        plannedAmount: balance,
      } satisfies APRow
    })
    .filter((r): r is APRow => r !== null)
}

// ─── Component ────────────────────────────────────────────────────────────────

const BALANCE_KEY = 'funding_plan_balance'

export default function FundingPlanPage() {
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekMonday(new Date()))
  const weekEnd = addDays(weekStart, 6)

  const [balance, setBalance] = useState<string>('')
  const [balanceSaved, setBalanceSaved] = useState<number>(0)

  const [arRows, setArRows] = useState<ARRow[]>([])
  const [apRows, setApRows] = useState<APRow[]>([])
  const [apPlanned, setApPlanned] = useState<Record<string, string>>({})

  const [arChecked, setArChecked] = useState<Set<string>>(new Set())
  const [apChecked, setApChecked] = useState<Set<string>>(new Set())

  const [loading, setLoading] = useState(true)

  // Load balance from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(BALANCE_KEY)
    const v = saved ? Number(saved) : 0
    setBalanceSaved(v)
    setBalance(saved ?? '0')
  }, [])

  // Load AR + AP data
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const supabase = createClient()

      // AR: budget_orders
      const { data: ordersData } = await supabase
        .from('budget_orders')
        .select('*, customer:customers(*)')
        .in('status', ['approved', 'closed'])
        .gt('total_revenue', 0)

      const orders = (ordersData || []) as BudgetOrder[]
      const ar = buildARRows(orders, weekStart, weekEnd)
      setArRows(ar)

      // AP: payable_records
      const { data: apData } = await supabase
        .from('payable_records')
        .select('*')
        .not('payment_status', 'in', '("paid","cancelled")')

      const apRecords = (apData || []) as PayableRecord[]
      const ap = buildAPRows(apRecords)
      setApRows(ap)

      // Init planned amounts
      const planned: Record<string, string> = {}
      ap.forEach(r => { planned[r.id] = String(r.plannedAmount) })
      setApPlanned(planned)
    } catch {
      // ignore
    }
    setLoading(false)
  }, [weekStart, weekEnd])

  useEffect(() => {
    loadData()
  }, [loadData])

  // KPI calculations
  const savedBalance = balanceSaved
  const arTotal = arRows
    .filter(r => arChecked.has(r.id))
    .reduce((s, r) => s + r.balance, 0)
  const apTotal = apRows
    .filter(r => apChecked.has(r.id))
    .reduce((s, r) => s + Number(apPlanned[r.id] || 0), 0)
  const endBalance = savedBalance + arTotal - apTotal

  function saveBalance() {
    const v = Number(balance)
    if (!Number.isNaN(v)) {
      localStorage.setItem(BALANCE_KEY, String(v))
      setBalanceSaved(v)
    }
  }

  function toggleAR(id: string) {
    setArChecked(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAP(id: string) {
    setApChecked(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAllAR(checked: boolean) {
    setArChecked(checked ? new Set(arRows.map(r => r.id)) : new Set())
  }

  function toggleAllAP(checked: boolean) {
    setApChecked(checked ? new Set(apRows.map(r => r.id)) : new Set())
  }

  // AR status badge
  function arStatusBadge(status: ARRow['status']) {
    if (status === 'overdue') return <Badge variant="destructive">逾期</Badge>
    if (status === 'due_this_week') return <Badge className="bg-amber-100 text-amber-800 border-amber-300">本周到期</Badge>
    return <Badge variant="outline">未到期</Badge>
  }

  // Export Excel
  function exportExcel() {
    const wb = XLSX.utils.book_new()

    // Sheet 1: 资金汇总
    const summaryData = [
      ['项目', '金额（CNY）'],
      ['账面资金', savedBalance],
      ['预计收款', arTotal],
      ['计划付款', apTotal],
      ['期末余额', endBalance],
    ]
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData)
    XLSX.utils.book_append_sheet(wb, ws1, '资金汇总')

    // Sheet 2: 客户应收
    const arData = [
      ['客户', '订单号', '币种', '应收金额', '已收', '余额', '到期日', '状态'],
      ...arRows.map(r => [
        r.customer,
        r.orderNo,
        r.currency,
        r.amount,
        r.paid,
        r.balance,
        r.dueDate,
        r.status === 'overdue' ? '逾期' : r.status === 'due_this_week' ? '本周到期' : '未到期',
      ]),
    ]
    const ws2 = XLSX.utils.aoa_to_sheet(arData)
    XLSX.utils.book_append_sheet(wb, ws2, '客户应收')

    // Sheet 3: 计划付款
    const apData = [
      ['供应商', '订单号', '应付金额', '计划付款', '到期日'],
      ...apRows.map(r => [
        r.supplier,
        r.orderNo,
        r.balance,
        Number(apPlanned[r.id] || 0),
        r.dueDate || '-',
      ]),
    ]
    const ws3 = XLSX.utils.aoa_to_sheet(apData)
    XLSX.utils.book_append_sheet(wb, ws3, '计划付款')

    const filename = `每周资金计划_${fmt(weekStart)}_${fmt(weekEnd)}.xlsx`
    XLSX.writeFile(wb, filename)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="每周资金计划" subtitle="应收跟踪 · 应付安排 · 期末余额预测" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* ── 周导航 + 账面资金 ── */}
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
          {/* 周导航 */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setWeekStart(d => addDays(d, -7))}
              aria-label="上一周"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium min-w-[160px] text-center">
              {fmtDisplay(weekStart)} — {fmtDisplay(weekEnd)}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setWeekStart(d => addDays(d, 7))}
              aria-label="下一周"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => setWeekStart(getWeekMonday(new Date()))}
            >
              本周
            </Button>
          </div>

          {/* 账面资金输入 */}
          <div className="flex items-center gap-2 ml-auto">
            <Label htmlFor="balance-input" className="text-sm whitespace-nowrap">账面资金</Label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-muted-foreground">¥</span>
              <Input
                id="balance-input"
                type="number"
                step="0.01"
                className="w-36"
                value={balance}
                onChange={e => setBalance(e.target.value)}
                onBlur={saveBalance}
                onKeyDown={e => { if (e.key === 'Enter') saveBalance() }}
              />
            </div>
          </div>
        </div>

        {/* ── KPI 4格 ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">账面资金</p>
              <p className="text-xl font-bold">¥{savedBalance.toLocaleString()}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">预计收款</p>
              <p className="text-xl font-bold text-green-600">
                ¥{arTotal.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">{arChecked.size} 笔已勾选</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">计划付款</p>
              <p className="text-xl font-bold text-red-600">
                ¥{apTotal.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">{apChecked.size} 笔已勾选</p>
            </CardContent>
          </Card>
          <Card className={endBalance < 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1">期末余额</p>
              <p className={`text-xl font-bold ${endBalance < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                ¥{endBalance.toLocaleString()}
              </p>
              <p className="text-xs text-muted-foreground">账面 + 收款 - 付款</p>
            </CardContent>
          </Card>
        </div>

        {/* ── 客户应收 ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              客户应收
              <span className="text-sm font-normal text-muted-foreground ml-2">
                共 {arRows.length} 笔未收款
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={arRows.length > 0 && arChecked.size === arRows.length}
                      onCheckedChange={(v) => toggleAllAR(!!v)}
                      aria-label="全选应收"
                    />
                  </TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead>币种</TableHead>
                  <TableHead className="text-right">应收金额</TableHead>
                  <TableHead>到期日</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {arRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                      暂无未收款项
                    </TableCell>
                  </TableRow>
                )}
                {arRows.map(r => (
                  <TableRow
                    key={r.id}
                    className={
                      r.status === 'overdue'
                        ? 'bg-red-50/50'
                        : r.status === 'due_this_week'
                        ? 'bg-amber-50/50'
                        : ''
                    }
                  >
                    <TableCell>
                      <Checkbox
                        checked={arChecked.has(r.id)}
                        onCheckedChange={() => toggleAR(r.id)}
                        aria-label={`勾选 ${r.orderNo}`}
                      />
                    </TableCell>
                    <TableCell className="text-sm font-medium">{r.customer}</TableCell>
                    <TableCell className="text-sm">{r.orderNo}</TableCell>
                    <TableCell className="text-sm">{r.currency}</TableCell>
                    <TableCell className="text-right text-sm font-semibold">
                      {r.currency} {r.balance.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm">{r.dueDate}</TableCell>
                    <TableCell>{arStatusBadge(r.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* ── 本周应付 ── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              本周应付
              <span className="text-sm font-normal text-muted-foreground ml-2">
                共 {apRows.length} 笔待付款
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={apRows.length > 0 && apChecked.size === apRows.length}
                      onCheckedChange={(v) => toggleAllAP(!!v)}
                      aria-label="全选应付"
                    />
                  </TableHead>
                  <TableHead>供应商</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead className="text-right">应付金额</TableHead>
                  <TableHead className="text-right w-36">计划金额</TableHead>
                  <TableHead>到期日</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                      暂无待付款项
                    </TableCell>
                  </TableRow>
                )}
                {apRows.map(r => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Checkbox
                        checked={apChecked.has(r.id)}
                        onCheckedChange={() => toggleAP(r.id)}
                        aria-label={`勾选 ${r.orderNo}`}
                      />
                    </TableCell>
                    <TableCell className="text-sm font-medium">{r.supplier}</TableCell>
                    <TableCell className="text-sm">{r.orderNo}</TableCell>
                    <TableCell className="text-right text-sm">
                      {r.currency} {r.balance.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        className="h-7 text-xs text-right w-28 ml-auto"
                        value={apPlanned[r.id] ?? ''}
                        onChange={e =>
                          setApPlanned(prev => ({ ...prev, [r.id]: e.target.value }))
                        }
                      />
                    </TableCell>
                    <TableCell className="text-sm">{r.dueDate || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* ── 导出按钮 ── */}
        <div className="flex justify-end pb-4">
          <Button onClick={exportExcel} className="gap-2">
            <Download className="h-4 w-4" />
            导出 Excel
          </Button>
        </div>

      </div>
    </div>
  )
}
