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
  DollarSign, AlertTriangle, Clock, Search, TrendingDown, Loader2, CheckCircle2, Pencil,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { getBudgetOrders, updateBudgetOrderReceivable, writeOffReceivable, correctOrderRevenue } from '@/lib/supabase/queries'
import Link from 'next/link'
import type { BudgetOrder } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'

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
  receivedAt: string | null
  bank: string | null
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
      if (o.status !== 'approved' && o.status !== 'closed') return false
      if (!o.total_revenue || o.total_revenue <= 0) return false
      return true
    })
    .map(o => {
      const deliveryDate = o.delivery_date ? new Date(o.delivery_date) : new Date(o.order_date)
      const dueDate = new Date(deliveryDate)
      dueDate.setDate(dueDate.getDate() + 30)

      const isPastDue = now > dueDate
      const agingDays = isPastDue
        ? Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0

      const explicit = o.ar_received_amount != null && !Number.isNaN(Number(o.ar_received_amount))
      const paid = explicit
        ? Math.min(Math.max(0, Number(o.ar_received_amount)), o.total_revenue)
        : (o.status === 'closed' ? o.total_revenue : 0)
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
        receivedAt: o.ar_received_at || null,
        bank: o.ar_received_bank || null,
      }
    })
}

export default function ReceivablesPage() {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('all')
  const [loading, setLoading] = useState(true)
  const [receivables, setReceivables] = useState<ReceivableRow[]>([])
  const [draftCount, setDraftCount] = useState(0)

  // ── 登记收款 Dialog ─────────────────────────────────────────
  const [receiptDialog, setReceiptDialog] = useState<ReceivableRow | null>(null)
  const [receiptAmount, setReceiptAmount] = useState('')
  const [receiptDate, setReceiptDate] = useState('')
  const [receiptBank, setReceiptBank] = useState('')
  const [receiptSaving, setReceiptSaving] = useState(false)

  // ── 核销余额 Dialog ─────────────────────────────────────────
  const [writeOffDialog, setWriteOffDialog] = useState<ReceivableRow | null>(null)
  const [writeOffReason, setWriteOffReason] = useState('')
  const [writeOffSaving, setWriteOffSaving] = useState(false)

  // ── 修正订单金额 Dialog ──────────────────────────────────────
  const [correctDialog, setCorrectDialog] = useState<ReceivableRow | null>(null)
  const [correctAmount, setCorrectAmount] = useState('')
  const [correctReason, setCorrectReason] = useState('')
  const [correctSaving, setCorrectSaving] = useState(false)

  async function reload() {
    const orders = await getBudgetOrders()
    setDraftCount(orders.filter(o => o.status === 'draft' || o.status === 'pending_review').length)
    setReceivables(buildReceivables(orders))
  }

  useEffect(() => {
    async function load() {
      try { await reload() } catch { /* empty */ }
      setLoading(false)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 登记收款 ────────────────────────────────────────────────
  async function saveReceipt() {
    if (!receiptDialog) return
    const amt = Number(receiptAmount)
    if (receiptAmount === '' || Number.isNaN(amt) || amt < 0) {
      toast.error('请输入有效的收款金额')
      return
    }
    setReceiptSaving(true)
    const at = receiptDate ? new Date(receiptDate + 'T12:00:00').toISOString() : null
    const { error } = await updateBudgetOrderReceivable(receiptDialog.id, {
      ar_received_amount: amt,
      ar_received_at: at,
      ar_received_bank: receiptBank.trim() || null,
    })
    setReceiptSaving(false)
    // 银行列缺失时返回部分成功提示（仍已保存金额/日期）：用 warning 不当作失败
    if (error) {
      if (error.includes('收款银行')) toast.warning(error)
      else { toast.error(error); return }
    } else {
      toast.success('收款信息已保存')
    }
    setReceiptDialog(null)
    setReceiptAmount('')
    setReceiptDate('')
    setReceiptBank('')
    try { await reload() } catch { /* empty */ }
  }

  // ── 核销余额 ────────────────────────────────────────────────
  async function saveWriteOff() {
    if (!writeOffDialog) return
    if (!writeOffReason.trim()) { toast.error('请填写核销原因'); return }
    setWriteOffSaving(true)
    const { error } = await writeOffReceivable(
      writeOffDialog.id,
      writeOffDialog.amount,
      writeOffReason.trim()
    )
    setWriteOffSaving(false)
    if (error) { toast.error(error); return }
    toast.success(`余额 ${writeOffDialog.currency} ${writeOffDialog.balance.toLocaleString()} 已核销`)
    setWriteOffDialog(null)
    setWriteOffReason('')
    try { await reload() } catch { /* empty */ }
  }

  // ── 修正订单金额 ─────────────────────────────────────────────
  async function saveCorrectRevenue() {
    if (!correctDialog) return
    const amt = Number(correctAmount)
    if (!correctAmount || Number.isNaN(amt) || amt <= 0) {
      toast.error('请输入有效的修正金额')
      return
    }
    if (!correctReason.trim()) { toast.error('请填写修正原因'); return }
    setCorrectSaving(true)
    const { error } = await correctOrderRevenue(correctDialog.id, amt, correctReason.trim())
    setCorrectSaving(false)
    if (error) { toast.error(error); return }
    toast.success(`订单金额已修正为 ${correctDialog.currency} ${amt.toLocaleString()}`)
    setCorrectDialog(null)
    setCorrectAmount('')
    setCorrectReason('')
    try { await reload() } catch { /* empty */ }
  }

  // ── 统计 ─────────────────────────────────────────────────────
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
    const matchSearch = !search
      || r.customer.toLowerCase().includes(search.toLowerCase())
      || r.orderNo.toLowerCase().includes(search.toLowerCase())
    return matchTab && matchSearch
  })

  // 历史收款银行（去重）— 供登记弹窗下拉建议
  const bankOptions = Array.from(new Set(
    receivables.map(r => r.bank).filter((b): b is string => !!b && b.trim() !== '')
  )).sort()

  const statusConfig = {
    paid:    { label: '已收',  variant: 'default' as const },
    partial: { label: '部分收', variant: 'secondary' as const },
    unpaid:  { label: '未收',  variant: 'outline' as const },
    overdue: { label: '逾期',  variant: 'destructive' as const },
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      <Header title="应收账款管理" subtitle="基于已审批订单自动生成 · 账龄追踪 · 回款监控" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50"><DollarSign className="h-4 w-4 text-blue-600" /></div>
              <div><p className="text-xs text-muted-foreground">应收总额</p><p className="text-xl font-bold">¥{totalBalance.toLocaleString()}</p></div>
            </CardContent>
          </Card>
          <Card className={overdueBalance > 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-50"><AlertTriangle className="h-4 w-4 text-red-600" /></div>
              <div><p className="text-xs text-muted-foreground">逾期金额</p><p className="text-xl font-bold text-red-600">¥{overdueBalance.toLocaleString()}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-50"><Clock className="h-4 w-4 text-amber-600" /></div>
              <div><p className="text-xs text-muted-foreground">逾期笔数</p><p className="text-xl font-bold">{overdue.length}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-50"><TrendingDown className="h-4 w-4 text-green-600" /></div>
              <div>
                <p className="text-xs text-muted-foreground">已收回比率</p>
                <p className="text-xl font-bold">
                  {receivables.length > 0
                    ? Math.round(receivables.filter(r => r.status === 'paid').length / receivables.length * 100)
                    : 0}%
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 引导提示 */}
        {receivables.length === 0 && draftCount > 0 && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="p-4 flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
              <div>
                <p className="text-sm font-medium text-amber-800">当前有 {draftCount} 个订单待审批</p>
                <p className="text-xs text-amber-600 mt-0.5">订单审批通过后，应收账款会自动生成。请先到「订单成本核算」页面提交审批。</p>
              </div>
            </CardContent>
          </Card>
        )}

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
              <TabsTrigger value="overdue" className={overdue.length > 0 ? 'text-red-600' : ''}>
                逾期 ({overdue.length})
              </TabsTrigger>
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
                  <TableHead>实际收款日</TableHead>
                  <TableHead>收款银行</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right w-[160px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(r => {
                  const sc = statusConfig[r.status]
                  return (
                    <TableRow key={r.id} className={r.status === 'overdue' ? 'bg-red-50/50' : ''}>
                      <TableCell>
                        <div>
                          <p className="text-sm font-medium">{r.customer}</p>
                          <p className="text-xs text-muted-foreground">{r.country}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Link href={`/orders/${r.id}`} className="text-primary text-sm hover:underline">
                          {r.orderNo}
                        </Link>
                      </TableCell>
                      {/* 订单金额 — 点击铅笔图标可修正 */}
                      <TableCell className="text-right">
                        <span className="text-sm">{r.currency} {r.amount.toLocaleString()}</span>
                        <button
                          className="ml-1.5 text-muted-foreground hover:text-primary opacity-50 hover:opacity-100 transition-opacity"
                          title="修正订单金额"
                          onClick={() => {
                            setCorrectDialog(r)
                            setCorrectAmount(String(r.amount))
                            setCorrectReason('')
                          }}
                        >
                          <Pencil className="h-3 w-3 inline" />
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-green-600 text-sm">
                        {r.currency} {r.paid.toLocaleString()}
                      </TableCell>
                      <TableCell className={`text-right font-semibold text-sm ${r.balance > 0 ? 'text-red-600' : 'text-green-600'}`}>
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
                      <TableCell className="text-sm text-muted-foreground">
                        {r.receivedAt ? new Date(r.receivedAt).toLocaleDateString('zh-CN') : '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[140px] truncate" title={r.bank || ''}>
                        {r.bank || '—'}
                      </TableCell>
                      <TableCell><Badge variant={sc.variant}>{sc.label}</Badge></TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {/* 核销余额 — 只对部分收款显示 */}
                          {r.status === 'partial' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
                              onClick={() => {
                                setWriteOffDialog(r)
                                setWriteOffReason('')
                              }}
                            >
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              核销余额
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              setReceiptDialog(r)
                              setReceiptAmount(String(r.paid))
                              setReceiptDate(
                                r.receivedAt
                                  ? r.receivedAt.slice(0, 10)
                                  : new Date().toISOString().slice(0, 10)
                              )
                              setReceiptBank(r.bank || '')
                            }}
                          >
                            登记收款
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center py-12 text-muted-foreground">
                      {receivables.length === 0
                        ? '暂无已审批订单，应收数据将在订单审批通过后自动生成'
                        : '没有匹配的记录'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* ── 登记收款 Dialog ─────────────────────────────────── */}
      <Dialog open={!!receiptDialog} onOpenChange={(open) => { if (!open) setReceiptDialog(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>登记实际收款</DialogTitle>
          </DialogHeader>
          {receiptDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                订单 <span className="font-medium text-foreground">{receiptDialog.orderNo}</span>
                {' · '}应收 {receiptDialog.currency} {receiptDialog.amount.toLocaleString()}
              </p>
              <div className="space-y-2">
                <Label>实际收款金额（{receiptDialog.currency}）</Label>
                <Input
                  type="number" step="0.01" min={0}
                  value={receiptAmount}
                  onChange={e => setReceiptAmount(e.target.value)}
                  placeholder={`最大 ${receiptDialog.amount}`}
                />
              </div>
              <div className="space-y-2">
                <Label>实际收款日期</Label>
                <Input type="date" value={receiptDate} onChange={e => setReceiptDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>收款银行 / 账户</Label>
                <Input
                  list="ar-bank-options"
                  placeholder="如：工行义乌分行 / 招行 6222... / PayPal"
                  value={receiptBank}
                  onChange={e => setReceiptBank(e.target.value)}
                />
                <datalist id="ar-bank-options">
                  {bankOptions.map(b => <option key={b} value={b} />)}
                </datalist>
                <p className="text-[11px] text-muted-foreground">记录这笔钱打到了哪个银行账户，方便后续核对回款流向。可从下拉选历史银行，也可直接输入新的。</p>
              </div>
              <p className="text-xs text-muted-foreground">
                未手动登记时，「已关闭」订单仍按原逻辑视为全额已收。登记后以此金额与日期为准。
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiptDialog(null)}>取消</Button>
            <Button onClick={saveReceipt} disabled={receiptSaving}>
              {receiptSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 核销余额 Dialog ─────────────────────────────────── */}
      <Dialog open={!!writeOffDialog} onOpenChange={(open) => { if (!open) setWriteOffDialog(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>核销应收余额</DialogTitle>
          </DialogHeader>
          {writeOffDialog && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-1">
                <p className="text-sm font-medium text-amber-800">
                  订单 {writeOffDialog.orderNo} · {writeOffDialog.customer}
                </p>
                <div className="flex justify-between text-sm text-amber-700">
                  <span>已收：{writeOffDialog.currency} {writeOffDialog.paid.toLocaleString()}</span>
                  <span>待核销余额：<strong>{writeOffDialog.currency} {writeOffDialog.balance.toLocaleString()}</strong></span>
                </div>
              </div>
              <div className="space-y-2">
                <Label>
                  核销原因 <span className="text-red-500">*</span>
                </Label>
                <Textarea
                  placeholder="例：客户尾款差额豁免 / 运费抵扣 / 汇率损益 / 双方协商平账..."
                  value={writeOffReason}
                  onChange={e => setWriteOffReason(e.target.value)}
                  rows={3}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                核销后状态变为「已收」，原因将记录到订单备注中，操作不可撤销。
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setWriteOffDialog(null)}>取消</Button>
            <Button
              onClick={saveWriteOff}
              disabled={writeOffSaving || !writeOffReason.trim()}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {writeOffSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
              确认核销
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 修正订单金额 Dialog ──────────────────────────────── */}
      <Dialog open={!!correctDialog} onOpenChange={(open) => { if (!open) setCorrectDialog(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>修正订单金额</DialogTitle>
          </DialogHeader>
          {correctDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                订单 <span className="font-medium text-foreground">{correctDialog.orderNo}</span>
                {' · '}当前金额：{correctDialog.currency} {correctDialog.amount.toLocaleString()}
              </p>
              <div className="space-y-2">
                <Label>
                  修正后金额（{correctDialog.currency}）<span className="text-red-500">*</span>
                </Label>
                <Input
                  type="number" step="0.01" min={0.01}
                  value={correctAmount}
                  onChange={e => setCorrectAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>
                  修正原因 <span className="text-red-500">*</span>
                </Label>
                <Textarea
                  placeholder="例：原始录入有误 / 汇率调整 / 合同变更..."
                  value={correctReason}
                  onChange={e => setCorrectReason(e.target.value)}
                  rows={2}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                修改将直接更新订单金额，修正记录写入订单备注。请确认已知会相关同事。
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectDialog(null)}>取消</Button>
            <Button
              onClick={saveCorrectRevenue}
              disabled={correctSaving || !correctAmount || !correctReason.trim()}
            >
              {correctSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : '确认修正'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
