'use client'

// ============================================================
// 应收账款 · 客户维度工作台（左客户列表 + 右多标签明细）
// 第一维度=客户（催款 / 风险），右侧每个客户一个标签，零再请求。
// 数据：budget_orders（已审批/已关闭）的 total_revenue / ar_received_*；
//      内部订单号来自 synced_orders.style_no（按相关订单号精准查询，不拉全表）。
// 金额口径：未收/逾期均按人民币(¥)汇总，同时保留原币字段。
// ============================================================

import { bizToday } from '@/lib/biz-date'
import { useState, useEffect, useMemo, Fragment } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { DollarSign, AlertTriangle, Search, Loader2, CheckCircle2, Pencil, Download, X, Plus, Link2, ChevronDown, ChevronRight, Trash2, Inbox } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { getBudgetOrders, writeOffReceivable, correctOrderRevenue } from '@/lib/supabase/queries'
import { getReceivablePayments, getReceivableAllocations, createReceivablePayment, allocateReceipt, unallocateReceipt, voidReceivablePayment, correctReceivableRate } from '@/lib/supabase/queries-v2'
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import Link from 'next/link'
import type { BudgetOrder, ReceivablePayment, ReceivablePaymentAllocation } from '@/lib/types'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'

type ARStatus = 'unpaid' | 'partial' | 'paid' | 'overdue' | 'abnormal'
type ReceivableRow = {
  id: string
  customer: string
  country: string
  orderNo: string       // 财务单号 BO-
  internalNo: string    // 内部订单号 style_no
  customerPO: string    // 客户PO
  currency: string
  rate: number
  amount: number        // 合同额（原币）
  amountCny: number
  paid: number          // 已收（原币）
  paidCny: number
  balance: number       // 未收（原币）
  balanceCny: number
  orderDate: string
  dueDate: string       // 应收日期
  receivedAt: string | null
  bank: string | null
  status: ARStatus
  agingDays: number
  notes: string
  hasLedger: boolean    // 已收是否来自回款流水（true=流水权威；false=历史 projection）
}

type CustomerAR = {
  customer: string
  country: string
  contractCny: number
  receivedCny: number
  unpaidCny: number
  overdueCny: number
  overdueCount: number
  lastReceiptDate: string | null
  recoveryRate: number
  avgAgingDays: number
  risk: '低' | '中' | '高'
  rows: ReceivableRow[]
}

const STATUS = {
  paid:     { label: '已收',  variant: 'default' as const },
  partial:  { label: '部分收', variant: 'secondary' as const },
  unpaid:   { label: '未收',  variant: 'outline' as const },
  overdue:  { label: '逾期',  variant: 'destructive' as const },
  abnormal: { label: '多收',  variant: 'destructive' as const },
}
const RISK_COLOR: Record<CustomerAR['risk'], string> = { 低: 'bg-green-100 text-green-700', 中: 'bg-amber-100 text-amber-700', 高: 'bg-red-100 text-red-700' }

function parseField(notes: string | null | undefined, label: RegExp): string {
  if (!notes) return ''
  const m = notes.match(label)
  return m ? m[1].trim() : ''
}

function buildReceivables(orders: BudgetOrder[], syncMap: Map<string, string>, allocatedByOrder: Map<string, number>): ReceivableRow[] {
  const now = new Date()
  return orders
    .filter(o => (o.status === 'approved' || o.status === 'closed') && o.total_revenue && o.total_revenue > 0)
    .map(o => {
      const deliveryDate = o.delivery_date ? new Date(o.delivery_date) : new Date(o.order_date)
      const dueDate = new Date(deliveryDate); dueDate.setDate(dueDate.getDate() + 30)
      const isPastDue = now > dueDate
      const agingDays = isPastDue ? Math.floor((now.getTime() - dueDate.getTime()) / 86400000) : 0

      const amount = Number(o.total_revenue) || 0
      const rate = o.currency === 'CNY' ? 1 : (Number(o.exchange_rate) || 1)
      // 真实已收：优先回款分配合计(权威)；无分配的历史订单回退 ar_received_amount projection
      const allocCny = allocatedByOrder.get(o.id)
      const hasLedger = allocCny != null
      let paid: number; let paidCnyVal: number
      if (hasLedger) {
        paidCnyVal = Math.round(allocCny * 100) / 100
        paid = Math.round((allocCny / rate) * 100) / 100
      } else {
        const explicit = o.ar_received_amount != null && !Number.isNaN(Number(o.ar_received_amount))
        paid = Math.max(0, explicit ? Number(o.ar_received_amount) : (o.status === 'closed' ? amount : 0))
        paidCnyVal = Math.round(paid * rate * 100) / 100
      }
      const balance = amount - paid

      let status: ARStatus
      if (amount <= 0 || paid - amount > 0.01) status = 'abnormal'   // 金额异常 / 多收
      else if (amount - paid <= 0.01) status = 'paid'
      else if (isPastDue) status = 'overdue'
      else if (paid > 0.01) status = 'partial'
      else status = 'unpaid'

      const internalNo = syncMap.get(o.id) || parseField(o.notes, /报价单号[:：]\s*([^\n]+)/) || ''
      const customerPO = parseField(o.notes, /PO\s*号[:：]\s*([^\n]+)/i) || parseField(o.notes, /PO[:：]\s*([^\n]+)/i) || ''

      return {
        id: o.id,
        customer: o.customer?.company || '未指定客户',
        country: o.customer?.country || '',
        orderNo: o.order_no,
        internalNo, customerPO,
        currency: o.currency, rate,
        amount, amountCny: Math.round(amount * rate * 100) / 100,
        paid, paidCny: paidCnyVal,
        balance, balanceCny: Math.round(amount * rate * 100) / 100 - paidCnyVal,
        orderDate: o.order_date,
        dueDate: dueDate.toISOString().substring(0, 10),
        receivedAt: o.ar_received_at || null,
        bank: o.ar_received_bank || null,
        status, agingDays,
        notes: o.notes || '',
        hasLedger,
      }
    })
}

const r2 = (n: number) => Math.round(n * 100) / 100

export default function ReceivablesPage() {
  // ── 权限边界（试运行：UI 层；后续接 role-based RLS）──
  const { user } = useCurrentUser()
  const role = user?.role || ''
  const canRegister = ['admin', 'finance_manager', 'finance_staff'].includes(role) // 财务员可登记回款/收款/匹配
  const canMatch = canRegister
  const canManage = ['admin', 'finance_manager'].includes(role)                    // 财务经理可撤销/作废/核销/修正
  const canDispute = role === 'admin'                                              // 财务负责人/老板处理争议

  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [receivables, setReceivables] = useState<ReceivableRow[]>([])
  const [draftCount, setDraftCount] = useState(0)
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  // 回款流水层
  const [receipts, setReceipts] = useState<ReceivablePayment[]>([])
  const [allocations, setAllocations] = useState<ReceivablePaymentAllocation[]>([])
  const [showUnmatched, setShowUnmatched] = useState(false)   // 右侧切到「未匹配回款」视图
  const [expandedOrder, setExpandedOrder] = useState<Record<string, boolean>>({})
  // 登记回款 Dialog
  const [regOpen, setRegOpen] = useState(false)
  const [regForm, setRegForm] = useState({ customer: '', amount: '', currency: 'CNY', rate: '1', date: bizToday(), bank: '', ref: '', source: 'manual' as ReceivablePayment['source_type'], notes: '' })
  const [regSaving, setRegSaving] = useState(false)
  // 匹配 Dialog（把某回款匹配到某订单）
  const [matchReceipt, setMatchReceipt] = useState<ReceivablePayment | null>(null)
  const [matchOrderId, setMatchOrderId] = useState('')
  const [matchAmount, setMatchAmount] = useState('')
  const [matchSaving, setMatchSaving] = useState(false)

  const [receiptDialog, setReceiptDialog] = useState<ReceivableRow | null>(null)
  const [receiptAmount, setReceiptAmount] = useState('')
  const [receiptDate, setReceiptDate] = useState('')
  const [receiptBank, setReceiptBank] = useState('')
  const [receiptRate, setReceiptRate] = useState('1')  // 实际结汇汇率（美金等外币收款用）
  const [receiptSaving, setReceiptSaving] = useState(false)

  const [writeOffDialog, setWriteOffDialog] = useState<ReceivableRow | null>(null)
  const [writeOffReason, setWriteOffReason] = useState('')
  const [writeOffSaving, setWriteOffSaving] = useState(false)

  const [correctDialog, setCorrectDialog] = useState<ReceivableRow | null>(null)
  const [correctAmount, setCorrectAmount] = useState('')
  const [correctReason, setCorrectReason] = useState('')
  const [correctSaving, setCorrectSaving] = useState(false)

  async function reload() {
    const [orders, recv, allocs] = await Promise.all([getBudgetOrders(), getReceivablePayments(), getReceivableAllocations()])
    setDraftCount(orders.filter(o => o.status === 'draft' || o.status === 'pending_review').length)
    setReceipts(recv)
    setAllocations(allocs)
    const arOrders = orders.filter(o => (o.status === 'approved' || o.status === 'closed') && o.total_revenue && o.total_revenue > 0)
    // 内部订单号：仅按相关订单精准查询 synced_orders（不拉全表）
    const boIds = arOrders.map(o => o.id)
    const syncMap = new Map<string, string>()
    if (boIds.length > 0) {
      const { data: synced } = await createClient().from('synced_orders').select('budget_order_id, style_no').in('budget_order_id', boIds)
      ;(synced || []).forEach((s: Record<string, unknown>) => {
        if (s.budget_order_id && s.style_no) syncMap.set(s.budget_order_id as string, String(s.style_no))
      })
    }
    // 每订单已分配回款合计（权威已收）
    const allocatedByOrder = new Map<string, number>()
    for (const a of allocs) allocatedByOrder.set(a.budget_order_id, (allocatedByOrder.get(a.budget_order_id) || 0) + (Number(a.amount_cny) || 0))
    setReceivables(buildReceivables(orders, syncMap, allocatedByOrder))
  }

  useEffect(() => {
    async function load() { try { await reload() } catch { /* */ } setLoading(false) }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 客户聚合
  const customers = useMemo<CustomerAR[]>(() => {
    const map = new Map<string, CustomerAR>()
    for (const r of receivables) {
      let c = map.get(r.customer)
      if (!c) { c = { customer: r.customer, country: r.country, contractCny: 0, receivedCny: 0, unpaidCny: 0, overdueCny: 0, overdueCount: 0, lastReceiptDate: null, recoveryRate: 0, avgAgingDays: 0, risk: '低', rows: [] }; map.set(r.customer, c) }
      c.rows.push(r)
      c.contractCny += r.amountCny
      c.receivedCny += r.paidCny
      if (r.balanceCny > 0.01) c.unpaidCny += r.balanceCny
      if (r.status === 'overdue') { c.overdueCny += r.balanceCny; c.overdueCount += 1 }
      if (r.receivedAt && (!c.lastReceiptDate || r.receivedAt > c.lastReceiptDate)) c.lastReceiptDate = r.receivedAt
    }
    return Array.from(map.values()).map(c => {
      const unpaidRows = c.rows.filter(r => r.balanceCny > 0.01)
      const avgAging = unpaidRows.length ? Math.round(unpaidRows.reduce((s, r) => s + r.agingDays, 0) / unpaidRows.length) : 0
      const maxAging = Math.max(0, ...c.rows.filter(r => r.status === 'overdue').map(r => r.agingDays))
      const risk: CustomerAR['risk'] = c.overdueCny > 0.01
        ? ((maxAging > 90 || (c.unpaidCny > 0 && c.overdueCny / c.unpaidCny > 0.5)) ? '高' : '中')
        : '低'
      return {
        ...c,
        contractCny: r2(c.contractCny), receivedCny: r2(c.receivedCny), unpaidCny: r2(c.unpaidCny), overdueCny: r2(c.overdueCny),
        recoveryRate: c.contractCny > 0 ? Math.round((c.receivedCny / c.contractCny) * 1000) / 10 : 0,
        avgAgingDays: avgAging, risk,
      }
    }).sort((a, b) => b.unpaidCny - a.unpaidCny)
  }, [receivables])

  const customerMap = useMemo(() => { const m = new Map<string, CustomerAR>(); customers.forEach(c => m.set(c.customer, c)); return m }, [customers])

  // ── 回款流水派生 ──
  // receipt → 已分配合计(¥)
  const allocatedByReceipt = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of allocations) m.set(a.receipt_id, (m.get(a.receipt_id) || 0) + (Number(a.amount_cny) || 0))
    return m
  }, [allocations])
  // 订单 → 该订单的分配明细（用于订单行展开）
  const allocationsByOrder = useMemo(() => {
    const m = new Map<string, ReceivablePaymentAllocation[]>()
    for (const a of allocations) { const arr = m.get(a.budget_order_id) || []; arr.push(a); m.set(a.budget_order_id, arr) }
    return m
  }, [allocations])
  const receiptById = useMemo(() => { const m = new Map<string, ReceivablePayment>(); receipts.forEach(r => m.set(r.id, r)); return m }, [receipts])
  // 客户 → 回款流水
  const receiptsByCustomer = useMemo(() => {
    const m = new Map<string, ReceivablePayment[]>()
    for (const r of receipts) { const k = (r.customer_name || '未指定客户'); const arr = m.get(k) || []; arr.push(r); m.set(k, arr) }
    return m
  }, [receipts])
  // 未匹配回款（有未分配余额）
  const unmatchedReceipts = useMemo(
    () => receipts.filter(r => (Number(r.amount_cny) || 0) - (allocatedByReceipt.get(r.id) || 0) > 0.01),
    [receipts, allocatedByReceipt],
  )

  // 搜索：客户名 / 内部订单号 / 客户PO
  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customers
    return customers.filter(c =>
      c.customer.toLowerCase().includes(q) ||
      c.rows.some(r => r.internalNo.toLowerCase().includes(q) || r.customerPO.toLowerCase().includes(q) || r.orderNo.toLowerCase().includes(q)),
    )
  }, [customers, search])

  const openCustomer = (name: string) => { setShowUnmatched(false); setOpenTabs(p => p.includes(name) ? p : [...p, name]); setActiveTab(name) }
  const closeTab = (name: string) => setOpenTabs(p => { const next = p.filter(t => t !== name); setActiveTab(cur => cur === name ? (next[next.length - 1] || null) : cur); return next })

  // KPI（全局）
  const totalUnpaid = customers.reduce((s, c) => s + c.unpaidCny, 0)
  const totalOverdue = customers.reduce((s, c) => s + c.overdueCny, 0)
  const totalContract = customers.reduce((s, c) => s + c.contractCny, 0)
  const totalReceived = customers.reduce((s, c) => s + c.receivedCny, 0)

  const bankOptions = Array.from(new Set(receivables.map(r => r.bank).filter((b): b is string => !!b && b.trim() !== ''))).sort()

  // 快捷登记收款 — 财务化：不再直写 ar_received_amount（projection），改为
  // 自动生成回款流水并匹配到本订单（RPC 内回写 projection）。操作习惯不变、数据归一：
  //   - 有流水的订单：录入新的「累计已收」，差额自动建一条流水并匹配；
  //   - 历史订单（已收来自旧登记、无流水）：首次快捷登记会把整笔累计已收合并成一条流水入账；
  //   - 调减不允许走快捷登记 → 引导到回款流水撤销匹配（可追溯）。
  async function saveReceipt() {
    if (!receiptDialog) return
    const amt = Number(receiptAmount)
    if (receiptAmount === '' || Number.isNaN(amt) || amt < 0) { toast.error('请输入有效的收款金额'); return }
    setReceiptSaving(true)
    const at = receiptDate ? new Date(receiptDate + 'T12:00:00').toISOString() : null
    const row = receiptDialog
    // 实际结汇汇率：CNY 恒 1；外币用本次收款填写的汇率（而非订单预算汇率）
    const effRate = row.currency === 'CNY' ? 1 : (Number(receiptRate) || 0)
    if (row.currency !== 'CNY' && effRate <= 0) { toast.error('请输入有效的结汇汇率'); return }
    const delta = r2(amt - row.paid)
    try {
      if (delta < -0.005) {
        toast.error('快捷登记不支持调减已收。请到「回款流水」中撤销对应匹配（需财务主管权限），保证每笔调整可追溯。')
        setReceiptSaving(false)
        return
      }
      // 入账金额：有流水按差额；无流水的历史订单首次登记按整笔累计（把历史已收合并进流水，防止覆盖丢失）
      const amountOriginal = row.hasLedger ? delta : r2(amt)
      if (amountOriginal > 0.005) {
        const { data: pay, error: payErr } = await createReceivablePayment({
          customer_name: row.customer,
          budget_order_id: row.id,
          amount_original: amountOriginal,
          currency: row.currency || 'CNY',
          exchange_rate: effRate,
          received_at: at,
          bank_account: receiptBank.trim() || null,
          source_type: 'manual',
          notes: row.hasLedger ? '快捷登记收款（自动建流水）' : '快捷登记收款（含历史已收合并入流水）',
        })
        if (payErr || !pay) { toast.error(`生成回款流水失败：${payErr || '未知错误'}`); setReceiptSaving(false); return }
        const amountCny = r2(amountOriginal * effRate)
        const { error: allocErr } = await allocateReceipt({ receipt_id: pay.id, budget_order_id: row.id, amount_cny: amountCny, amount_original: amountOriginal })
        if (allocErr) {
          toast.error(`流水已生成但自动匹配失败：${allocErr}。请到「回款流水」手动匹配该笔（金额 ¥${amountCny.toLocaleString()}）`)
          setReceiptSaving(false)
          try { await reload() } catch { /* */ }
          return
        }
        toast.success(row.hasLedger ? `已生成回款流水并匹配 ¥${amountCny.toLocaleString()}` : '已将累计已收合并为回款流水并匹配')
      } else if (row.currency !== 'CNY' && row.hasLedger) {
        // 金额没变但可能要改汇率：把原流水作废、按新结汇汇率重建（可追溯）
        const supabase = createClient()
        const { data: allocs } = await supabase.from('receivable_payment_allocations')
          .select('payment_id').eq('budget_order_id', row.id).is('voided_at', null)
        const payIds = [...new Set((allocs || []).map(a => a.payment_id as string))]
        if (payIds.length !== 1) {
          toast.error('该订单由多笔回款流水构成，请到「回款流水」逐笔修正汇率，以免影响其他订单。')
          setReceiptSaving(false); return
        }
        const pid = payIds[0]
        const { data: payRow } = await supabase.from('receivable_payments').select('exchange_rate').eq('id', pid).maybeSingle()
        const { data: otherAllocs } = await supabase.from('receivable_payment_allocations').select('budget_order_id').eq('payment_id', pid).is('voided_at', null)
        const exclusive = (otherAllocs || []).every(a => a.budget_order_id === row.id)
        if (Math.abs((Number(payRow?.exchange_rate) || 0) - effRate) < 0.0001) {
          toast.success('金额与汇率均无变化，已更新收款银行/日期')
        } else if (!exclusive) {
          toast.error('该笔回款流水还匹配了其他订单，请到「回款流水」修正汇率，以免影响其他订单。')
          setReceiptSaving(false); return
        } else {
          // 单事务 RPC：作废原流水→按新汇率重建→重新匹配，原子完成（无中途失败的中间态）
          const { data: corr, error: cErr } = await correctReceivableRate({
            old_payment_id: pid, budget_order_id: row.id, amount_original: r2(amt),
            currency: row.currency || 'CNY', rate: effRate, received_at: at, bank: receiptBank.trim() || null,
            reason: `汇率修正 ${payRow?.exchange_rate}→${effRate}`,
          })
          if (cErr || !corr) { toast.error(`汇率修正失败：${cErr || '未知'}（作废需财务主管权限）`); setReceiptSaving(false); return }
          toast.success(`已按结汇汇率 ${effRate} 修正，折人民币 ¥${corr.amount_cny.toLocaleString()}`)
        }
      } else {
        toast.success('金额无变化，已更新收款银行/日期')
      }
      // 银行/日期仍记到订单（展示便利字段，不动金额——金额由 RPC 回写 projection）
      if (receiptBank.trim() || at) {
        const supabase = createClient()
        await supabase.from('budget_orders').update({ ar_received_at: at, ar_received_bank: receiptBank.trim() || null }).eq('id', row.id)
      }
    } finally {
      setReceiptSaving(false)
    }
    fetch('/api/gl/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessEvent: 'receipt_saved', sourceType: 'receipt', sourceId: receiptDialog.id }) }).catch(err => console.error('[GL] 收款入队失败:', err))
    setReceiptDialog(null); setReceiptAmount(''); setReceiptDate(''); setReceiptBank(''); setReceiptRate('1')
    try { await reload() } catch { /* */ }
  }

  async function saveWriteOff() {
    if (!writeOffDialog) return
    if (!writeOffReason.trim()) { toast.error('请填写核销原因'); return }
    setWriteOffSaving(true)
    const { error } = await writeOffReceivable(writeOffDialog.id, writeOffDialog.amount, writeOffReason.trim())
    setWriteOffSaving(false)
    if (error) { toast.error(error); return }
    toast.success(`余额 ${writeOffDialog.currency} ${writeOffDialog.balance.toLocaleString()} 已核销`)
    setWriteOffDialog(null); setWriteOffReason('')
    try { await reload() } catch { /* */ }
  }

  async function saveCorrectRevenue() {
    if (!correctDialog) return
    const amt = Number(correctAmount)
    if (!correctAmount || Number.isNaN(amt) || amt <= 0) { toast.error('请输入有效的修正金额'); return }
    if (!correctReason.trim()) { toast.error('请填写修正原因'); return }
    setCorrectSaving(true)
    const { error } = await correctOrderRevenue(correctDialog.id, amt, correctReason.trim())
    setCorrectSaving(false)
    if (error) { toast.error(error); return }
    toast.success(`订单金额已修正为 ${correctDialog.currency} ${amt.toLocaleString()}`)
    setCorrectDialog(null); setCorrectAmount(''); setCorrectReason('')
    try { await reload() } catch { /* */ }
  }

  // ── 登记回款（写入流水层）──
  async function handleRegister() {
    const amt = Number(regForm.amount)
    if (!regForm.customer.trim()) { toast.error('请填写客户'); return }
    if (!amt || amt <= 0) { toast.error('请输入有效金额'); return }
    setRegSaving(true)
    const { error } = await createReceivablePayment({
      customer_name: regForm.customer.trim(), amount_original: amt, currency: regForm.currency,
      exchange_rate: regForm.currency === 'CNY' ? 1 : Number(regForm.rate) || 1,
      received_at: regForm.date || null, bank_account: regForm.bank.trim() || null,
      payment_reference: regForm.ref.trim() || null, source_type: regForm.source, notes: regForm.notes.trim() || null,
    })
    setRegSaving(false)
    if (error) { toast.error(error); return }
    toast.success('回款已登记，进入「未匹配回款」等待匹配')
    setRegOpen(false)
    setRegForm({ customer: '', amount: '', currency: 'CNY', rate: '1', date: bizToday(), bank: '', ref: '', source: 'manual', notes: '' })
    try { await reload() } catch { /* */ }
  }

  // ── 匹配 / 撤销 / 作废 ──
  const openMatch = (r: ReceivablePayment) => {
    setMatchReceipt(r)
    const remain = Math.round(((Number(r.amount_cny) || 0) - (allocatedByReceipt.get(r.id) || 0)) * 100) / 100
    setMatchAmount(String(remain))
    // 自动建议：同客户、未结清、PO/金额接近的第一笔
    const cand = receivables.filter(o => o.customer === (r.customer_name || '') && o.balanceCny > 0.01)
      .sort((a, b) => Math.abs(a.balanceCny - remain) - Math.abs(b.balanceCny - remain))
    setMatchOrderId(cand[0]?.id || '')
  }
  async function handleMatch() {
    if (!matchReceipt) return
    const amt = Number(matchAmount)
    if (!matchOrderId) { toast.error('请选择要匹配的订单'); return }
    if (!amt || amt <= 0) { toast.error('请输入有效匹配金额'); return }
    setMatchSaving(true)
    const { error } = await allocateReceipt({ receipt_id: matchReceipt.id, budget_order_id: matchOrderId, amount_cny: amt })
    setMatchSaving(false)
    if (error) {
      if (/OVER_ALLOCATION/.test(error)) toast.error('匹配金额超过该回款可分配余额')
      else toast.error(error)
      return
    }
    toast.success('已匹配')
    setMatchReceipt(null); setMatchOrderId(''); setMatchAmount('')
    try { await reload() } catch { /* */ }
  }
  async function handleUnallocate(allocationId: string) {
    if (!confirm('确认撤销这笔匹配？（订单已收将相应减少）')) return
    const { error } = await unallocateReceipt(allocationId, '人工撤销匹配')
    if (error) { toast.error(error); return }
    toast.success('已撤销匹配')
    try { await reload() } catch { /* */ }
  }
  async function handleVoidReceipt(r: ReceivablePayment) {
    if (!confirm(`确认作废这笔回款 ¥${r.amount_cny.toLocaleString()}？其匹配会一并撤销。`)) return
    const { error } = await voidReceivablePayment(r.id, '人工作废')
    if (error) { toast.error(error); return }
    toast.success('回款已作废')
    try { await reload() } catch { /* */ }
  }

  const exportCustomer = (c: CustomerAR) => {
    const headers = ['内部订单号', '客户PO', '合同额原币', '币种', '汇率', '合同额¥', '已收原币', '已收¥', '未收¥', '应收日期', '实际收款日', '收款银行', '状态', '备注']
    const lines = c.rows.map(r => [
      r.internalNo, r.customerPO, r.amount, r.currency, r.rate, r.amountCny, r.paid, r.paidCny, r.balanceCny,
      r.dueDate, r.receivedAt ? r.receivedAt.slice(0, 10) : '', (r.bank || '').replace(/,/g, ' '), STATUS[r.status].label, (r.notes || '').replace(/[\n,]/g, ' '),
    ].join(','))
    const csv = [headers.join(','), ...lines].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `应收明细_${c.customer}_${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(url)
    toast.success('已导出该客户应收明细')
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const openReceipt = (r: ReceivableRow) => { setReceiptDialog(r); setReceiptAmount(String(r.paid)); setReceiptDate(r.receivedAt ? r.receivedAt.slice(0, 10) : bizToday()); setReceiptBank(r.bank || ''); setReceiptRate(String(r.currency === 'CNY' ? 1 : (r.rate || 1))) }

  return (
    <div className="flex flex-col h-full">
      <Header title="应收账款管理" subtitle="客户维度 · 左选客户右多标签同时打开对比 · 未收/逾期按人民币口径" />

      {/* KPI */}
      <div className="px-4 md:px-6 pt-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-blue-50"><DollarSign className="h-4 w-4 text-blue-600" /></div><div><p className="text-xs text-muted-foreground">未收总额(¥)</p><p className="text-xl font-bold">¥{totalUnpaid.toLocaleString()}</p></div></CardContent></Card>
        <Card className={totalOverdue > 0 ? 'border-red-200' : ''}><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-red-50"><AlertTriangle className="h-4 w-4 text-red-600" /></div><div><p className="text-xs text-muted-foreground">逾期金额(¥)</p><p className="text-xl font-bold text-red-600">¥{r2(totalOverdue).toLocaleString()}</p></div></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">客户数</p><p className="text-xl font-bold">{customers.length}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">整体回款率</p><p className="text-xl font-bold">{totalContract > 0 ? Math.round(totalReceived / totalContract * 100) : 0}%</p></CardContent></Card>
      </div>

      {draftCount > 0 && receivables.length === 0 && (
        <div className="px-4 md:px-6 pt-3"><Card className="border-amber-200 bg-amber-50/50"><CardContent className="p-3 text-sm text-amber-700">当前有 {draftCount} 个订单待审批，审批通过后应收自动生成。</CardContent></Card></div>
      )}

      {/* 左右分栏 */}
      <div className="flex-1 flex overflow-hidden mt-3 border-t min-h-0">
        {/* 左：客户列表 */}
        <div className="w-80 shrink-0 border-r flex flex-col bg-muted/10">
          <div className="p-3 border-b space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="搜索客户 / 内部订单号 / 客户PO..." className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {canRegister && (
              <div className="flex items-center gap-2">
                <Button size="sm" className="flex-1 h-8" onClick={() => setRegOpen(true)}><Plus className="h-4 w-4 mr-1" />登记回款</Button>
              </div>
            )}
            <button
              onClick={() => setShowUnmatched(true)}
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded-md text-sm border ${showUnmatched ? 'border-primary bg-primary/10' : unmatchedReceipts.length > 0 ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-border text-muted-foreground'}`}>
              <span className="inline-flex items-center gap-1"><Inbox className="h-3.5 w-3.5" />未匹配回款</span>
              <Badge className={unmatchedReceipts.length > 0 ? 'bg-amber-500 text-white' : 'bg-muted text-muted-foreground'}>{unmatchedReceipts.length}</Badge>
            </button>
            <p className="text-[11px] text-muted-foreground">共 {filteredCustomers.length} 个客户</p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredCustomers.map(c => {
              const isActive = activeTab === c.customer
              return (
                <button key={c.customer} onClick={() => openCustomer(c.customer)}
                  className={`w-full text-left px-3 py-2.5 border-b border-border/60 hover:bg-muted/50 transition ${isActive ? 'bg-primary/10 border-l-2 border-l-primary' : openTabs.includes(c.customer) ? 'bg-muted/30' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{c.customer}</span>
                    <Badge className={`text-[10px] shrink-0 ${RISK_COLOR[c.risk]}`}>{c.risk}险</Badge>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[11px] text-muted-foreground">未收</span>
                    <span className={`text-sm font-semibold ${c.unpaidCny > 0.01 ? 'text-red-600' : 'text-green-600'}`}>¥{c.unpaidCny.toLocaleString()}</span>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    合同¥{(c.contractCny / 1000).toFixed(0)}k · 已收¥{(c.receivedCny / 1000).toFixed(0)}k
                    {c.overdueCny > 0.01 && <span className="text-red-500"> · 逾期¥{c.overdueCny.toLocaleString()}({c.overdueCount}单)</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">最近回款 {c.lastReceiptDate ? new Date(c.lastReceiptDate).toLocaleDateString('zh-CN') : '—'}</div>
                </button>
              )
            })}
            {filteredCustomers.length === 0 && <div className="text-center py-12 text-muted-foreground text-sm">无匹配客户</div>}
          </div>
        </div>

        {/* 右：未匹配回款 / 客户多标签明细 */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {showUnmatched ? (
            <div className="flex-1 overflow-y-auto p-4 md:p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold inline-flex items-center gap-2"><Inbox className="h-4 w-4 text-amber-600" />未匹配回款 ({unmatchedReceipts.length})</h3>
                {canRegister && <Button size="sm" onClick={() => setRegOpen(true)}><Plus className="h-4 w-4 mr-1" />登记回款</Button>}
              </div>
              <p className="text-xs text-muted-foreground">下列回款还有未分配到订单的余额。点「匹配」分配到订单（支持部分匹配、一笔配多单）；点「作废」撤销整笔回款。</p>
              <Card>
                <CardContent className="p-0 overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>到账日</TableHead><TableHead>客户</TableHead>
                      <TableHead className="text-right">金额(原币)</TableHead><TableHead>币种</TableHead>
                      <TableHead className="text-right">金额¥</TableHead><TableHead className="text-right">已分配¥</TableHead><TableHead className="text-right">未分配¥</TableHead>
                      <TableHead>银行</TableHead><TableHead>流水号</TableHead><TableHead>来源</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {unmatchedReceipts.map(r => {
                        const allocated = allocatedByReceipt.get(r.id) || 0
                        const remain = Math.round(((Number(r.amount_cny) || 0) - allocated) * 100) / 100
                        return (
                          <TableRow key={r.id}>
                            <TableCell className="text-xs">{r.received_at ? new Date(r.received_at).toLocaleDateString('zh-CN') : '—'}</TableCell>
                            <TableCell className="text-sm">{r.customer_name || '—'}</TableCell>
                            <TableCell className="text-right text-sm">{r.amount_original.toLocaleString()}</TableCell>
                            <TableCell className="text-sm">{r.currency}</TableCell>
                            <TableCell className="text-right text-sm">¥{r.amount_cny.toLocaleString()}</TableCell>
                            <TableCell className="text-right text-sm text-green-700">¥{allocated.toLocaleString()}</TableCell>
                            <TableCell className="text-right text-sm font-semibold text-amber-600">¥{remain.toLocaleString()}</TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">{r.bank_account || '—'}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{r.payment_reference || '—'}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{r.source_type}</TableCell>
                            <TableCell className="text-right whitespace-nowrap">
                              {canMatch && <Button variant="outline" size="sm" className="h-7 text-xs mr-1" onClick={() => openMatch(r)}><Link2 className="h-3 w-3 mr-1" />匹配</Button>}
                              {(canManage || canDispute) && <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500" onClick={() => handleVoidReceipt(r)}><Trash2 className="h-3 w-3" /></Button>}
                              {!canMatch && !canManage && <span className="text-xs text-muted-foreground">只读</span>}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                      {unmatchedReceipts.length === 0 && <TableRow><TableCell colSpan={11} className="text-center py-12 text-muted-foreground">没有未匹配回款 🎉</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          ) : openTabs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <DollarSign className="h-10 w-10 opacity-30 mb-3" />
              <p className="text-sm">从左侧点击客户查看应收明细</p>
              <p className="text-xs mt-1">可点击多个，像浏览器标签一样同时打开对比</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 border-b px-2 py-1.5 overflow-x-auto bg-muted/20">
                {openTabs.map(name => (
                  <div key={name} onClick={() => setActiveTab(name)}
                    className={`flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-md text-sm cursor-pointer whitespace-nowrap shrink-0 ${activeTab === name ? 'bg-background border shadow-sm font-medium' : 'hover:bg-background/60 text-muted-foreground'}`}>
                    <span className="truncate max-w-[140px]">{name}</span>
                    <span onClick={(e) => { e.stopPropagation(); closeTab(name) }} className="rounded p-0.5 hover:bg-muted"><X className="h-3 w-3" /></span>
                  </div>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto min-w-0">
                {openTabs.map(name => {
                  const c = customerMap.get(name)
                  if (!c) return null
                  return (
                    <div key={name} className={activeTab === name ? 'p-4 md:p-5 space-y-4' : 'hidden'}>
                      {/* 客户应收三角 + 指标 */}
                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <h3 className="text-base font-semibold">{c.customer} <Badge className={`ml-1 text-[10px] ${RISK_COLOR[c.risk]}`}>{c.risk}风险</Badge></h3>
                        <Button variant="outline" size="sm" onClick={() => exportCustomer(c)}><Download className="h-4 w-4 mr-1" />导出应收明细</Button>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                        <Card><CardContent className="p-3"><p className="text-[11px] text-muted-foreground">合同额合计</p><p className="text-lg font-bold">¥{c.contractCny.toLocaleString()}</p></CardContent></Card>
                        <Card><CardContent className="p-3"><p className="text-[11px] text-muted-foreground">已收合计</p><p className="text-lg font-bold text-green-600">¥{c.receivedCny.toLocaleString()}</p></CardContent></Card>
                        <Card className={c.unpaidCny > 0.01 ? 'border-red-200' : ''}><CardContent className="p-3"><p className="text-[11px] text-muted-foreground">未收合计</p><p className={`text-lg font-bold ${c.unpaidCny > 0.01 ? 'text-red-600' : 'text-green-600'}`}>¥{c.unpaidCny.toLocaleString()}</p></CardContent></Card>
                        <Card className={c.overdueCny > 0.01 ? 'border-red-200 bg-red-50/40' : ''}><CardContent className="p-3"><p className="text-[11px] text-muted-foreground">逾期金额</p><p className={`text-lg font-bold ${c.overdueCny > 0.01 ? 'text-red-600' : ''}`}>¥{c.overdueCny.toLocaleString()}</p></CardContent></Card>
                        <Card><CardContent className="p-3"><p className="text-[11px] text-muted-foreground">回款率</p><p className="text-lg font-bold">{c.recoveryRate}%</p></CardContent></Card>
                        <Card><CardContent className="p-3"><p className="text-[11px] text-muted-foreground">平均账期</p><p className="text-lg font-bold">{c.avgAgingDays}天</p></CardContent></Card>
                      </div>

                      {/* 明细表 */}
                      <Card>
                        <CardContent className="p-0 overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>内部订单号</TableHead>
                                <TableHead>客户PO</TableHead>
                                <TableHead className="text-right">合同额(原币)</TableHead>
                                <TableHead>币种</TableHead>
                                <TableHead className="text-right">汇率</TableHead>
                                <TableHead className="text-right">合同额¥</TableHead>
                                <TableHead className="text-right">已收(原币)</TableHead>
                                <TableHead className="text-right">已收¥</TableHead>
                                <TableHead className="text-right">未收¥</TableHead>
                                <TableHead>应收日期</TableHead>
                                <TableHead>实际收款日</TableHead>
                                <TableHead>收款银行</TableHead>
                                <TableHead>状态</TableHead>
                                <TableHead>备注</TableHead>
                                <TableHead className="text-right w-[150px]">操作</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {c.rows.map(r => {
                                const orderAllocs = allocationsByOrder.get(r.id) || []
                                const open = !!expandedOrder[r.id]
                                return (
                                <Fragment key={r.id}>
                                <TableRow className={r.status === 'overdue' || r.status === 'abnormal' ? 'bg-red-50/40' : ''}>
                                  <TableCell className="text-sm font-medium">
                                    {orderAllocs.length > 0 && (
                                      <button className="mr-1 align-middle text-muted-foreground" onClick={() => setExpandedOrder(p => ({ ...p, [r.id]: !p[r.id] }))} title="查看回款明细">
                                        {open ? <ChevronDown className="h-3.5 w-3.5 inline" /> : <ChevronRight className="h-3.5 w-3.5 inline" />}
                                      </button>
                                    )}
                                    <Link href={`/orders/${r.id}`} className="text-primary hover:underline">{r.internalNo || r.orderNo}</Link>
                                    {orderAllocs.length > 0 && <span className="ml-1 text-[10px] text-muted-foreground">({orderAllocs.length}笔回款)</span>}
                                  </TableCell>
                                  <TableCell className="text-sm">{r.customerPO || '—'}</TableCell>
                                  <TableCell className="text-right text-sm">
                                    {r.amount.toLocaleString()}
                                    {canManage && <button className="ml-1 text-muted-foreground hover:text-primary opacity-50 hover:opacity-100" title="修正订单金额"
                                      onClick={() => { setCorrectDialog(r); setCorrectAmount(String(r.amount)); setCorrectReason('') }}><Pencil className="h-3 w-3 inline" /></button>}
                                  </TableCell>
                                  <TableCell className="text-sm">{r.currency}</TableCell>
                                  <TableCell className="text-right text-xs text-muted-foreground">{r.currency === 'CNY' ? '—' : r.rate}</TableCell>
                                  <TableCell className="text-right text-sm">¥{r.amountCny.toLocaleString()}</TableCell>
                                  <TableCell className="text-right text-sm text-green-600">{r.paid.toLocaleString()}</TableCell>
                                  <TableCell className="text-right text-sm text-green-600">¥{r.paidCny.toLocaleString()}</TableCell>
                                  <TableCell className={`text-right text-sm font-semibold ${r.balanceCny > 0.01 ? 'text-red-600' : 'text-green-600'}`}>¥{r.balanceCny.toLocaleString()}</TableCell>
                                  <TableCell className="text-xs">{r.dueDate}{r.agingDays > 0 && <span className="text-red-500"> · 逾{r.agingDays}天</span>}</TableCell>
                                  <TableCell className="text-xs text-muted-foreground">{r.receivedAt ? new Date(r.receivedAt).toLocaleDateString('zh-CN') : '—'}</TableCell>
                                  <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate" title={r.bank || ''}>{r.bank || '—'}</TableCell>
                                  <TableCell><Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge></TableCell>
                                  <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate" title={r.notes}>{r.notes ? r.notes.replace(/\n/g, ' ') : '—'}</TableCell>
                                  <TableCell className="text-right whitespace-nowrap">
                                    {canManage && r.status === 'partial' && (
                                      <Button variant="outline" size="sm" className="h-7 text-xs border-amber-300 text-amber-700 mr-1" onClick={() => { setWriteOffDialog(r); setWriteOffReason('') }}><CheckCircle2 className="h-3 w-3 mr-1" />核销</Button>
                                    )}
                                    {canRegister
                                      ? <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openReceipt(r)}>登记收款</Button>
                                      : <span className="text-xs text-muted-foreground">只读</span>}
                                  </TableCell>
                                </TableRow>
                                {open && (
                                  <TableRow className="bg-muted/20">
                                    <TableCell colSpan={15} className="p-0">
                                      <div className="px-8 py-2">
                                        <p className="text-xs font-medium text-muted-foreground mb-1">回款明细（该订单）</p>
                                        <table className="w-full text-xs">
                                          <thead><tr className="text-muted-foreground">
                                            <th className="text-left py-1">到账日</th><th className="text-left">银行</th><th className="text-left">流水号</th>
                                            <th className="text-right">分配金额¥</th><th className="text-left pl-3">来源回款</th><th className="text-right">操作</th>
                                          </tr></thead>
                                          <tbody>
                                            {orderAllocs.map(a => {
                                              const rc = receiptById.get(a.receipt_id)
                                              return (
                                                <tr key={a.id} className="border-t border-border/40">
                                                  <td className="py-1">{rc?.received_at ? new Date(rc.received_at).toLocaleDateString('zh-CN') : '—'}</td>
                                                  <td>{rc?.bank_account || '—'}</td>
                                                  <td>{rc?.payment_reference || '—'}</td>
                                                  <td className="text-right text-green-700">¥{(Number(a.amount_cny) || 0).toLocaleString()}</td>
                                                  <td className="pl-3 text-muted-foreground">{rc ? `${rc.currency} ${rc.amount_original.toLocaleString()}` : '—'}</td>
                                                  <td className="text-right">{canManage ? <button className="text-red-500 hover:underline" onClick={() => handleUnallocate(a.id)}>撤销匹配</button> : <span className="text-muted-foreground">—</span>}</td>
                                                </tr>
                                              )
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                )}
                                </Fragment>
                                )
                              })}
                              <TableRow className="bg-muted/50 font-semibold border-t-2">
                                <TableCell colSpan={5} className="text-right">合计</TableCell>
                                <TableCell className="text-right">¥{c.contractCny.toLocaleString()}</TableCell>
                                <TableCell />
                                <TableCell className="text-right text-green-700">¥{c.receivedCny.toLocaleString()}</TableCell>
                                <TableCell className="text-right text-red-600">¥{c.unpaidCny.toLocaleString()}</TableCell>
                                <TableCell colSpan={6} />
                              </TableRow>
                            </TableBody>
                          </Table>
                        </CardContent>
                      </Card>
                      <p className="text-[11px] text-muted-foreground">应收日期 = 交货日 + 30 天（<span className="text-amber-600">默认账期</span>，后续可接客户付款条件）。</p>

                      {/* 该客户回款流水 */}
                      <Card>
                        <CardContent className="p-0 overflow-x-auto">
                          <p className="text-sm font-semibold px-4 pt-3">回款流水（{(receiptsByCustomer.get(c.customer) || []).length} 笔）</p>
                          <Table>
                            <TableHeader><TableRow>
                              <TableHead>到账日</TableHead><TableHead className="text-right">金额(原币)</TableHead><TableHead>币种</TableHead>
                              <TableHead className="text-right">金额¥</TableHead><TableHead className="text-right">已分配¥</TableHead>
                              <TableHead>银行</TableHead><TableHead>流水号</TableHead><TableHead>来源</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead>
                            </TableRow></TableHeader>
                            <TableBody>
                              {(receiptsByCustomer.get(c.customer) || []).map(rc => {
                                const allocated = allocatedByReceipt.get(rc.id) || 0
                                const ms = rc.matched_status
                                const msLabel = ms === 'matched' ? '已匹配' : ms === 'partially_matched' ? '部分匹配' : ms === 'disputed' ? '争议' : '未匹配'
                                return (
                                  <TableRow key={rc.id}>
                                    <TableCell className="text-xs">{rc.received_at ? new Date(rc.received_at).toLocaleDateString('zh-CN') : '—'}</TableCell>
                                    <TableCell className="text-right text-sm">{rc.amount_original.toLocaleString()}</TableCell>
                                    <TableCell className="text-sm">{rc.currency}</TableCell>
                                    <TableCell className="text-right text-sm">¥{rc.amount_cny.toLocaleString()}</TableCell>
                                    <TableCell className="text-right text-sm text-green-700">¥{allocated.toLocaleString()}</TableCell>
                                    <TableCell className="text-xs text-muted-foreground max-w-[120px] truncate">{rc.bank_account || '—'}</TableCell>
                                    <TableCell className="text-xs text-muted-foreground">{rc.payment_reference || '—'}</TableCell>
                                    <TableCell className="text-xs text-muted-foreground">{rc.source_type}</TableCell>
                                    <TableCell><Badge variant={ms === 'matched' ? 'default' : ms === 'unmatched' ? 'destructive' : 'secondary'}>{msLabel}</Badge></TableCell>
                                    <TableCell className="text-right whitespace-nowrap">
                                      {canMatch && ms !== 'matched' && ms !== 'disputed' && <Button variant="outline" size="sm" className="h-7 text-xs mr-1" onClick={() => openMatch(rc)}><Link2 className="h-3 w-3 mr-1" />匹配</Button>}
                                      {((canManage && ms !== 'disputed') || canDispute) && <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500" onClick={() => handleVoidReceipt(rc)}><Trash2 className="h-3 w-3" /></Button>}
                                    </TableCell>
                                  </TableRow>
                                )
                              })}
                              {(receiptsByCustomer.get(c.customer) || []).length === 0 && <TableRow><TableCell colSpan={10} className="text-center py-6 text-muted-foreground text-sm">该客户暂无回款流水（点上方「登记回款」录入）</TableCell></TableRow>}
                            </TableBody>
                          </Table>
                        </CardContent>
                      </Card>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 登记收款 Dialog ── */}
      <Dialog open={!!receiptDialog} onOpenChange={(open) => { if (!open) setReceiptDialog(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>登记实际收款</DialogTitle></DialogHeader>
          {receiptDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">订单 <span className="font-medium text-foreground">{receiptDialog.internalNo || receiptDialog.orderNo}</span>{' · '}应收 {receiptDialog.currency} {receiptDialog.amount.toLocaleString()}</p>
              <div className="space-y-2"><Label>实际收款金额（{receiptDialog.currency}）</Label><Input type="number" step="0.01" min={0} value={receiptAmount} onChange={e => setReceiptAmount(e.target.value)} placeholder={`最大 ${receiptDialog.amount}`} /></div>
              {receiptDialog.currency !== 'CNY' && (
                <div className="space-y-2">
                  <Label>实际结汇汇率（{receiptDialog.currency}→CNY）</Label>
                  <Input type="number" step="0.0001" min={0} value={receiptRate} onChange={e => setReceiptRate(e.target.value)} placeholder="如 7.18（按实际结汇填，可不同于订单预算汇率）" />
                  <p className="text-[11px] text-muted-foreground">
                    折人民币约 ¥{(((Number(receiptAmount) || 0) - receiptDialog.paid) * (Number(receiptRate) || 0) > 0
                      ? ((Number(receiptAmount) || 0) - receiptDialog.paid) * (Number(receiptRate) || 0)
                      : (Number(receiptAmount) || 0) * (Number(receiptRate) || 0)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    （订单预算汇率 {receiptDialog.rate}，本次按实际结汇汇率入账）
                  </p>
                </div>
              )}
              <div className="space-y-2"><Label>实际收款日期</Label><Input type="date" value={receiptDate} onChange={e => setReceiptDate(e.target.value)} /></div>
              <div className="space-y-2">
                <Label>收款银行 / 账户</Label>
                <Input list="ar-bank-options" placeholder="如：工行义乌分行 / 招行 6222... / PayPal" value={receiptBank} onChange={e => setReceiptBank(e.target.value)} />
                <datalist id="ar-bank-options">{bankOptions.map(b => <option key={b} value={b} />)}</datalist>
                <p className="text-[11px] text-muted-foreground">记录这笔钱打到哪个账户，方便核对回款流向。</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiptDialog(null)}>取消</Button>
            <Button onClick={saveReceipt} disabled={receiptSaving}>{receiptSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : '保存'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 核销余额 Dialog ── */}
      <Dialog open={!!writeOffDialog} onOpenChange={(open) => { if (!open) setWriteOffDialog(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>核销应收余额</DialogTitle></DialogHeader>
          {writeOffDialog && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 space-y-1">
                <p className="text-sm font-medium text-amber-800">订单 {writeOffDialog.internalNo || writeOffDialog.orderNo} · {writeOffDialog.customer}</p>
                <div className="flex justify-between text-sm text-amber-700"><span>已收：{writeOffDialog.currency} {writeOffDialog.paid.toLocaleString()}</span><span>待核销：<strong>{writeOffDialog.currency} {writeOffDialog.balance.toLocaleString()}</strong></span></div>
              </div>
              <div className="space-y-2"><Label>核销原因 <span className="text-red-500">*</span></Label><Textarea placeholder="例：尾款差额豁免 / 运费抵扣 / 汇率损益..." value={writeOffReason} onChange={e => setWriteOffReason(e.target.value)} rows={3} /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setWriteOffDialog(null)}>取消</Button>
            <Button onClick={saveWriteOff} disabled={writeOffSaving || !writeOffReason.trim()} className="bg-amber-600 hover:bg-amber-700 text-white">{writeOffSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}确认核销</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 修正订单金额 Dialog ── */}
      <Dialog open={!!correctDialog} onOpenChange={(open) => { if (!open) setCorrectDialog(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>修正订单金额</DialogTitle></DialogHeader>
          {correctDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">订单 <span className="font-medium text-foreground">{correctDialog.internalNo || correctDialog.orderNo}</span>{' · '}当前：{correctDialog.currency} {correctDialog.amount.toLocaleString()}</p>
              <div className="space-y-2"><Label>修正后金额（{correctDialog.currency}）<span className="text-red-500">*</span></Label><Input type="number" step="0.01" min={0.01} value={correctAmount} onChange={e => setCorrectAmount(e.target.value)} /></div>
              <div className="space-y-2"><Label>修正原因 <span className="text-red-500">*</span></Label><Textarea placeholder="例：原始录入有误 / 汇率调整 / 合同变更..." value={correctReason} onChange={e => setCorrectReason(e.target.value)} rows={2} /></div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectDialog(null)}>取消</Button>
            <Button onClick={saveCorrectRevenue} disabled={correctSaving || !correctAmount || !correctReason.trim()}>{correctSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : '确认修正'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 登记回款 Dialog（写入流水层）── */}
      <Dialog open={regOpen} onOpenChange={setRegOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>登记回款（银行收款流水）</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5"><Label>客户 *</Label><Input list="ar-cust-options" value={regForm.customer} onChange={e => setRegForm(f => ({ ...f, customer: e.target.value }))} placeholder="客户名称（与订单客户一致便于自动匹配）" /><datalist id="ar-cust-options">{customers.map(c => <option key={c.customer} value={c.customer} />)}</datalist></div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5 col-span-1"><Label>金额 *</Label><Input type="number" step="0.01" value={regForm.amount} onChange={e => setRegForm(f => ({ ...f, amount: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label>币种</Label>
                <Select value={regForm.currency} onValueChange={v => setRegForm(f => ({ ...f, currency: v || 'CNY' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="CNY">CNY</SelectItem><SelectItem value="USD">USD</SelectItem><SelectItem value="EUR">EUR</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5"><Label>汇率</Label><Input type="number" step="0.0001" value={regForm.currency === 'CNY' ? '1' : regForm.rate} disabled={regForm.currency === 'CNY'} onChange={e => setRegForm(f => ({ ...f, rate: e.target.value }))} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>到账日期</Label><Input type="date" value={regForm.date} onChange={e => setRegForm(f => ({ ...f, date: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label>来源</Label>
                <Select value={regForm.source} onValueChange={v => setRegForm(f => ({ ...f, source: (v as ReceivablePayment['source_type']) || 'manual' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="manual">手工录入</SelectItem><SelectItem value="bank_receipt">银行回单</SelectItem><SelectItem value="wecom_file">企微文件</SelectItem><SelectItem value="ocr">OCR</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5"><Label>收款银行/账户</Label><Input list="ar-bank-options" value={regForm.bank} onChange={e => setRegForm(f => ({ ...f, bank: e.target.value }))} /></div>
            <div className="space-y-1.5"><Label>银行流水号/凭证号</Label><Input value={regForm.ref} onChange={e => setRegForm(f => ({ ...f, ref: e.target.value }))} placeholder="同号+同客户+同金额+同日期不可重复录入" /></div>
            <div className="space-y-1.5"><Label>备注</Label><Textarea rows={2} value={regForm.notes} onChange={e => setRegForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegOpen(false)}>取消</Button>
            <Button onClick={handleRegister} disabled={regSaving}>{regSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}登记</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 匹配 Dialog（回款 → 订单）── */}
      <Dialog open={!!matchReceipt} onOpenChange={(o) => { if (!o) setMatchReceipt(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>匹配回款到订单</DialogTitle></DialogHeader>
          {matchReceipt && (() => {
            const allocated = allocatedByReceipt.get(matchReceipt.id) || 0
            const remain = Math.round(((Number(matchReceipt.amount_cny) || 0) - allocated) * 100) / 100
            const candidates = receivables.filter(o => o.customer === (matchReceipt.customer_name || '') && o.balanceCny > 0.01)
            return (
              <div className="space-y-3 py-2">
                <div className="rounded-md bg-muted/40 p-2 text-sm">
                  回款 <b>{matchReceipt.customer_name}</b> · {matchReceipt.currency} {matchReceipt.amount_original.toLocaleString()}（¥{matchReceipt.amount_cny.toLocaleString()}）· 可分配余额 <b className="text-amber-600">¥{remain.toLocaleString()}</b>
                </div>
                <div className="space-y-1.5">
                  <Label>匹配到订单 *</Label>
                  <Select value={matchOrderId} onValueChange={v => setMatchOrderId(v || '')}>
                    <SelectTrigger><SelectValue placeholder={candidates.length ? '选择该客户未结清订单' : '该客户暂无未结清订单'} /></SelectTrigger>
                    <SelectContent>
                      {candidates.map(o => <SelectItem key={o.id} value={o.id}>{o.internalNo || o.orderNo}（未收¥{o.balanceCny.toLocaleString()}{o.customerPO ? ' · PO ' + o.customerPO : ''}）</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {candidates.length === 0 && <p className="text-[11px] text-amber-600">该回款客户名与订单客户不一致？可改订单客户或在登记时填一致的客户名。</p>}
                </div>
                <div className="space-y-1.5">
                  <Label>本次匹配金额(¥) *</Label>
                  <Input type="number" step="0.01" value={matchAmount} onChange={e => setMatchAmount(e.target.value)} />
                  <p className="text-[11px] text-muted-foreground">支持部分匹配（小于余额）；一笔回款可多次匹配到不同订单。</p>
                </div>
              </div>
            )
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMatchReceipt(null)}>取消</Button>
            <Button onClick={handleMatch} disabled={matchSaving || !matchOrderId}>{matchSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4 mr-1" />}确认匹配</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
