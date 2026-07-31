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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  ChevronLeft, ChevronRight, Download, Loader2, Flame,
} from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { getMarketRate, resolveDisplayRate } from '@/lib/accounting/fx'
import { createPaymentBatch, addBatchLine, submitBatch } from '@/lib/supabase/payment-batches'
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
  balanceCny: number
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
  cnyRate: number
  // 本周口径(2026-07-30):按 due_date 落在本周区间分档。no_date=无到期日(不静默丢,
  // 单列一档提醒财务补账期),否则这类款永远进不了任何一周的表。
  status: 'overdue' | 'due_this_week' | 'upcoming' | 'no_date'
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

/** 本月区间(含首尾),用于「本月应收更新」 */
function monthRangeOf(date: Date): { start: Date; end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), 1)
  start.setHours(0, 0, 0, 0)
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

/** Inline buildReceivables logic (from receivables/page.tsx) */
function buildARRows(orders: BudgetOrder[], weekStart: Date, weekEnd: Date, marketRate: number): ARRow[] {
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

      // 折人民币(审计P1:此前原币直加进期末余额预测)。外币缺率兜底=市场汇率(P0,替代 ||7)
      const cnyRate = resolveDisplayRate(o.currency, o.exchange_rate, marketRate)
      return {
        id: o.id,
        customer: o.customer?.company || '-',
        orderNo: o.order_no,
        currency: o.currency,
        amount: o.total_revenue,
        paid,
        balance,
        balanceCny: Math.round(balance * cnyRate),
        dueDate: dueDateStr,
        status,
      } satisfies ARRow
    })
    .filter((r): r is ARRow => r !== null)
}

function buildAPRows(records: PayableRecord[], weekStart: Date, weekEnd: Date, marketRate: number): APRow[] {
  return records
    .filter(r => r.payment_status !== 'paid' && r.payment_status !== 'cancelled')
    .map(r => {
      const paidAmount = r.paid_amount || 0
      const balance = r.amount - paidAmount
      if (balance <= 0) return null
      // 按到期日分档(此前本卡片标题写「本周应付」却完全不过滤日期,把所有未付都列进来,
      // 与周五付款周期对不上;2026-07-30 补真实周口径)
      let status: APRow['status'] = 'no_date'
      if (r.due_date) {
        const due = new Date(r.due_date)
        status = due < weekStart ? 'overdue' : due <= weekEnd ? 'due_this_week' : 'upcoming'
      }
      return {
        id: r.id,
        supplier: r.supplier_name,
        orderNo: r.order_no || '-',
        currency: r.currency,
        amount: r.amount,
        balance,
        dueDate: r.due_date,
        plannedAmount: balance,
        // 优先用应付自带汇率(登记时的结算率),缺失才回退市场汇率(P0,替代写死 7)
        cnyRate: resolveDisplayRate(r.currency, r.exchange_rate ?? null, marketRate),
        status,
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

  // 周二交付(2026-07-30):两张表默认只看「本周该付/该收」(逾期+本周到期+无到期日),
  // 但保留「显示全部」开关——不静默藏数据。
  const [apWeekOnly, setApWeekOnly] = useState(true)
  const [arWeekOnly, setArWeekOnly] = useState(true)

  // 本月应收更新:本月到期应收 vs 本月实收(receivable_payments.received_at 落在本月)
  const [monthCollected, setMonthCollected] = useState(0)

  // 紧急付款例外:等不到周五的单笔,直接建「紧急排款单」提交(复用周排款 RPC 全套锁+角色闸)
  const [urgentFor, setUrgentFor] = useState<APRow | null>(null)
  const [urgentAmount, setUrgentAmount] = useState('')
  const [urgentNote, setUrgentNote] = useState('')
  const [urgentBusy, setUrgentBusy] = useState(false)

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
      const { rate: marketRate } = await getMarketRate(supabase)  // 外币缺率兜底=exchange_rates 最新市场汇率(P0)

      // AR: budget_orders
      const { data: ordersData } = await supabase
        .from('budget_orders')
        .select('*, customer:customers(*)')
        .in('status', ['approved', 'closed'])
        .is('deleted_at', null)   // 审计P1:此前软删订单重新出现在资金计划
        .gt('total_revenue', 0)

      const orders = (ordersData || []) as BudgetOrder[]
      const ar = buildARRows(orders, weekStart, weekEnd, marketRate)
      setArRows(ar)

      // AP: payable_records
      const { data: apData } = await supabase
        .from('payable_records')
        .select('*')
        .not('payment_status', 'in', '("paid","cancelled")')
        .is('deleted_at', null)   // 审计P1:排除软删应付

      const apRecords = (apData || []) as PayableRecord[]
      const ap = buildAPRows(apRecords, weekStart, weekEnd, marketRate)
      setApRows(ap)

      // 本月已收:回款流水按 received_at 落在本月(已折人民币,排除作废)
      const { start: mStart, end: mEnd } = monthRangeOf(weekStart)
      const { data: recData } = await supabase
        .from('receivable_payments')
        .select('amount_cny, received_at, voided_at')
        .gte('received_at', fmt(mStart))
        .lte('received_at', fmt(mEnd))
        .is('voided_at', null)
      setMonthCollected(
        (recData || []).reduce((s: number, r: { amount_cny: number | null }) => s + (Number(r.amount_cny) || 0), 0)
      )

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

  // ── 本周口径过滤(默认只看本周该付/该收;可切「全部」)──────────────────
  // 「本周该付/该收」= 逾期(拖到本周仍未清) + 本周到期 + 无到期日(缺账期,须财务补)
  const inThisWeek = (s: APRow['status'] | ARRow['status']) =>
    s === 'overdue' || s === 'due_this_week' || s === 'no_date'
  const apVisible = apWeekOnly ? apRows.filter(r => inThisWeek(r.status)) : apRows
  const arVisible = arWeekOnly ? arRows.filter(r => inThisWeek(r.status)) : arRows

  // ── 本月应收更新 ─────────────────────────────────────────────────────
  const { start: monthStart, end: monthEnd } = monthRangeOf(weekStart)
  const monthLabel = `${monthStart.getFullYear()}年${monthStart.getMonth() + 1}月`
  // 本月应收=到期日落在本月的未收余额(折 CNY);逾期挂账单独列,便于看"欠了多久"
  const monthDueRows = arRows.filter(r => {
    const d = new Date(r.dueDate)
    return d >= monthStart && d <= monthEnd
  })
  const monthDueCny = monthDueRows.reduce((s, r) => s + r.balanceCny, 0)
  const monthOverdueCny = arRows
    .filter(r => r.status === 'overdue' && new Date(r.dueDate) < monthStart)
    .reduce((s, r) => s + r.balanceCny, 0)
  // 收款率 = 本月实收 /(本月实收 + 本月仍未收);实收含往月账款的回款,故只作参考
  const monthTarget = monthCollected + monthDueCny
  const monthRatePct = monthTarget > 0 ? Math.round((monthCollected / monthTarget) * 1000) / 10 : 0

  // KPI calculations
  const savedBalance = balanceSaved
  // 折人民币口径(审计P1:此前原币直加)。应付无自带汇率,外币按≈7参考折算
  const arTotal = arRows
    .filter(r => arChecked.has(r.id))
    .reduce((s, r) => s + r.balanceCny, 0)
  const apTotal = apRows
    .filter(r => apChecked.has(r.id))
    .reduce((s, r) => s + Number(apPlanned[r.id] || 0) * r.cnyRate, 0)
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

  // 全选只作用于当前可见行(本周口径下不误勾未到期的)
  function toggleAllAR(checked: boolean) {
    setArChecked(checked ? new Set(arVisible.map(r => r.id)) : new Set())
  }

  function toggleAllAP(checked: boolean) {
    setApChecked(checked ? new Set(apVisible.map(r => r.id)) : new Set())
  }

  // ── 紧急付款例外:等不到周五的单笔,当场建「紧急排款单」并提交 ──────────
  // 不新开出款通道:复用周排款 RPC(角色闸 + 行锁 + 超付校验 + 真实 actor),
  // 只是不等周期。提交后仍需老板在「周排款」审批放款,出纳执行 —— 唯一出款口径不变。
  function openUrgent(r: APRow) {
    setUrgentFor(r)
    setUrgentAmount(String(Math.round(r.balance * 100) / 100))
    setUrgentNote('')
  }

  async function doUrgent() {
    if (!urgentFor) return
    const amt = Number(urgentAmount)
    const remaining = Math.round(urgentFor.balance * 100) / 100
    if (!(amt > 0)) { toast.error('金额必须大于 0'); return }
    if (amt > remaining + 0.005) { toast.error(`超出剩余应付 ${urgentFor.currency} ${remaining}`); return }
    setUrgentBusy(true)
    try {
      const created = await createPaymentBatch({
        currency: urgentFor.currency || 'CNY',
        planned_pay_date: fmt(new Date()),
        title: `紧急付款 · ${urgentFor.supplier}`,
        week_label: '紧急',
        notes: urgentNote.trim() || null,
      })
      if (created.error || !created.data?.id) { toast.error(created.error || '建紧急排款单失败'); return }
      const batchId = created.data.id as string
      const added = await addBatchLine(batchId, urgentFor.id, amt)
      if (added.error) { toast.error(`排入失败：${added.error}`); return }
      const sub = await submitBatch(batchId)
      if (sub.error) { toast.error(`提交失败：${sub.error}`); return }
      toast.success('🔥 紧急排款单已提交 —— 请老板到「周排款」审批放款，出纳即可付款')
      setUrgentFor(null)
      loadData()
    } finally { setUrgentBusy(false) }
  }

  // AR status badge
  function arStatusBadge(status: ARRow['status']) {
    if (status === 'overdue') return <Badge variant="destructive">逾期</Badge>
    if (status === 'due_this_week') return <Badge className="bg-amber-100 text-amber-800 border-amber-300">本周到期</Badge>
    return <Badge variant="outline">未到期</Badge>
  }

  // AP status badge(多一档「无到期日」——缺账期的款,提醒财务补,别让它永远漏排)
  function apStatusBadge(status: APRow['status']) {
    if (status === 'overdue') return <Badge variant="destructive">逾期</Badge>
    if (status === 'due_this_week') return <Badge className="bg-amber-100 text-amber-800 border-amber-300">本周到期</Badge>
    if (status === 'no_date') return <Badge className="bg-slate-100 text-slate-700 border-slate-300">无到期日</Badge>
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

    // Sheet 2: 本月应收更新
    const monthData = [
      ['项目', '金额（CNY）'],
      [`${monthLabel} 实收`, monthCollected],
      [`${monthLabel} 到期未收`, monthDueCny],
      ['往月逾期挂账', monthOverdueCny],
      ['本月收款率(%)', monthRatePct],
    ]
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthData), '本月应收更新')

    // Sheet 3: 本周应收(导出当前可见口径,与屏幕所见一致)
    const arData = [
      ['客户', '订单号', '币种', '应收金额', '已收', '余额', '到期日', '状态'],
      ...arVisible.map(r => [
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
    XLSX.utils.book_append_sheet(wb, ws2, arWeekOnly ? '本周应收' : '全部应收')

    // Sheet 4: 本周应付
    const apData = [
      ['供应商', '订单号', '币种', '应付余额', '计划付款', '到期日', '状态'],
      ...apVisible.map(r => [
        r.supplier,
        r.orderNo,
        r.currency,
        r.balance,
        Number(apPlanned[r.id] || 0),
        r.dueDate || '-',
        r.status === 'overdue' ? '逾期' : r.status === 'due_this_week' ? '本周到期' : r.status === 'no_date' ? '无到期日' : '未到期',
      ]),
    ]
    const ws3 = XLSX.utils.aoa_to_sheet(apData)
    XLSX.utils.book_append_sheet(wb, ws3, apWeekOnly ? '本周应付' : '全部应付')

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

        {/* ── 本周应收款表(周二完成)── */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-base">
                本周应收款表
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  {arWeekOnly ? `本周该收 ${arVisible.length} 笔` : `全部未收 ${arVisible.length} 笔`}
                  {arWeekOnly && arRows.length > arVisible.length && (
                    <span className="text-muted-foreground/70">（另有 {arRows.length - arVisible.length} 笔未到期）</span>
                  )}
                </span>
              </CardTitle>
              <Button variant="outline" size="sm" className="text-xs h-7"
                onClick={() => setArWeekOnly(v => !v)}>
                {arWeekOnly ? '显示全部未收' : '只看本周该收'}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              到期日 = 交货日(无则下单日) + 30 天。逾期/本周到期算「本周该收」。
            </p>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={arVisible.length > 0 && arVisible.every(r => arChecked.has(r.id))}
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
                {arVisible.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                      {arWeekOnly ? '本周没有该收的款 —— 都已收妥或未到期 👍' : '暂无未收款项'}
                    </TableCell>
                  </TableRow>
                )}
                {arVisible.map(r => (
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

        {/* ── 本月应收更新(周二随本周表一起过一遍)── */}
        <Card className="border-green-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              本月应收更新
              <span className="text-sm font-normal text-muted-foreground ml-2">{monthLabel}</span>
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              本月实收取自回款流水(已折人民币、排除作废);本月应收=到期日落在本月的未收余额。
              往月逾期挂账单列,别混进本月口径。
            </p>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="p-3 rounded-lg bg-green-50 border border-green-100">
                <p className="text-xs text-muted-foreground mb-1">本月实收</p>
                <p className="text-lg font-bold text-green-700">¥{monthCollected.toLocaleString()}</p>
              </div>
              <div className="p-3 rounded-lg bg-amber-50 border border-amber-100">
                <p className="text-xs text-muted-foreground mb-1">本月到期未收</p>
                <p className="text-lg font-bold text-amber-700">¥{monthDueCny.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground">{monthDueRows.length} 笔</p>
              </div>
              <div className="p-3 rounded-lg bg-red-50 border border-red-100">
                <p className="text-xs text-muted-foreground mb-1">往月逾期挂账</p>
                <p className="text-lg font-bold text-red-700">¥{monthOverdueCny.toLocaleString()}</p>
                <p className="text-[11px] text-muted-foreground">到期日早于本月</p>
              </div>
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-100">
                <p className="text-xs text-muted-foreground mb-1">本月收款率</p>
                <p className="text-lg font-bold text-blue-700">{monthRatePct}%</p>
                <p className="text-[11px] text-muted-foreground">实收 ÷（实收 + 到期未收）</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── 本周应付款表(周二完成 · 周五统一付)── */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-base">
                本周应付款表
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  {apWeekOnly ? `本周该付 ${apVisible.length} 笔` : `全部待付 ${apVisible.length} 笔`}
                  {apWeekOnly && apRows.length > apVisible.length && (
                    <span className="text-muted-foreground/70">（另有 {apRows.length - apVisible.length} 笔未到期）</span>
                  )}
                </span>
              </CardTitle>
              <Button variant="outline" size="sm" className="text-xs h-7"
                onClick={() => setApWeekOnly(v => !v)}>
                {apWeekOnly ? '显示全部未付' : '只看本周该付'}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              周二排定 → 周五统一付款。逾期/本周到期/无到期日都算「本周该付」。
              等不到周五的,用行末 🔥 立即付 走紧急通道。
            </p>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={apVisible.length > 0 && apVisible.every(r => apChecked.has(r.id))}
                      onCheckedChange={(v) => toggleAllAP(!!v)}
                      aria-label="全选应付"
                    />
                  </TableHead>
                  <TableHead>供应商</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead className="text-right">应付金额</TableHead>
                  <TableHead className="text-right w-36">计划金额</TableHead>
                  <TableHead>到期日</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-24 text-center">紧急</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apVisible.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                      {apWeekOnly ? '本周没有该付的款 —— 都已排定或未到期 👍' : '暂无待付款项'}
                    </TableCell>
                  </TableRow>
                )}
                {apVisible.map(r => (
                  <TableRow key={r.id}
                    className={r.status === 'overdue' ? 'bg-red-50/50' : r.status === 'due_this_week' ? 'bg-amber-50/50' : ''}>
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
                    <TableCell>{apStatusBadge(r.status)}</TableCell>
                    <TableCell className="text-center">
                      <Button variant="ghost" size="sm"
                        className="h-7 text-xs text-orange-600 hover:text-orange-700 hover:bg-orange-50 gap-1"
                        title="等不到周五:建紧急排款单立即提交(仍需老板审批放款)"
                        onClick={() => openUrgent(r)}>
                        <Flame className="h-3.5 w-3.5" />立即付
                      </Button>
                    </TableCell>
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

      {/* ── 紧急付款(周期例外)── */}
      <Dialog open={!!urgentFor} onOpenChange={(o) => { if (!o) setUrgentFor(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Flame className="h-4 w-4 text-orange-600" />紧急付款
            </DialogTitle>
          </DialogHeader>
          {urgentFor && (
            <div className="space-y-3 text-sm">
              <div className="p-3 rounded-lg bg-muted space-y-1">
                <div className="flex justify-between"><span className="text-muted-foreground">供应商</span><span className="font-medium">{urgentFor.supplier}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">订单号</span><span>{urgentFor.orderNo}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">剩余应付</span><span className="font-semibold">{urgentFor.currency} {urgentFor.balance.toLocaleString()}</span></div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">本次付款金额</Label>
                <Input type="number" step="0.01" min={0} value={urgentAmount} onChange={e => setUrgentAmount(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">紧急原因（建议填，留痕给老板看）</Label>
                <Input placeholder="如：定金不付停产 / 供应商断料" value={urgentNote} onChange={e => setUrgentNote(e.target.value)} />
              </div>
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                走的还是唯一出款通道:这里只建「🔥 紧急排款单」并提交,
                仍需老板在「周排款」审批放款、出纳执行 —— 不等周五,但不绕审批。
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUrgentFor(null)} disabled={urgentBusy}>取消</Button>
            <Button onClick={doUrgent} disabled={urgentBusy} className="gap-1">
              {urgentBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flame className="h-4 w-4" />}
              提交紧急排款
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
