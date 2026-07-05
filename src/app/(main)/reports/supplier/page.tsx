'use client'

import { bizToday } from '@/lib/biz-date'
import React, { useState, useEffect, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Search, Download, DollarSign, FileText, Clock, CheckCircle, Lock, Loader2, AlertTriangle, Edit, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { exportCostSummaryReport } from '@/lib/excel/export-professional'
import { exportSupplierStatementToExcel } from '@/lib/excel/export-supplier-statement'
import { normalizeSupplierName } from '@/lib/utils'
import { getSupplierPayments, createSupplierPayment, deleteSupplierPayment } from '@/lib/supabase/queries-v2'
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import type { SupplierPayment } from '@/lib/types'

interface SupplierLine {
  supplier: string
  count: number
  total: number
  paid: number
  unpaid: number
  currency: string
  orders: string[]
  isEdited?: boolean
  editNote?: string
}

type ReportStatus = 'draft' | 'reviewing' | 'confirmed' | 'locked'

const STATUS_CONFIG: Record<ReportStatus, { label: string; color: string }> = {
  draft: { label: '草稿(自动汇总)', color: 'bg-gray-100 text-gray-700' },
  reviewing: { label: '审核中(方圆)', color: 'bg-amber-100 text-amber-700' },
  confirmed: { label: '已确认(Su)', color: 'bg-green-100 text-green-700' },
  locked: { label: '已锁定(不可修改)', color: 'bg-blue-100 text-blue-700' },
}

export default function SupplierReportPage() {
  const { user } = useCurrentUser()
  const [lines, setLines] = useState<SupplierLine[]>([])
  const [allCostDetails, setAllCostDetails] = useState<{ supplier: string; description: string; amount: number; currency: string; cost_type: string; order_no: string; internal_no: string; metronome_no: string; created_at: string; is_paid: boolean; unit: string; qty: number | null; unit_price: number | null }[]>([])
  const [payments, setPayments] = useState<SupplierPayment[]>([])
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  // 默认显示"全部时间"，避免写死的日期把当期数据挡在外面（之前导致 5 月数据看不到）
  // 用户可手动设置日期范围或点"近 90 天"快捷按钮缩小
  const [dateStart, setDateStart] = useState('')
  const [dateEnd, setDateEnd] = useState('')
  const [status, setStatus] = useState<ReportStatus>('draft')
  const [snapshotId, setSnapshotId] = useState<string | null>(null)
  const [corrections, setCorrections] = useState<Record<string, unknown>[]>([])

  // 修正弹窗
  const [editDialog, setEditDialog] = useState<{ index: number; line: SupplierLine } | null>(null)
  const [editAmount, setEditAmount] = useState('')
  const [editReason, setEditReason] = useState('')
  const [processing, setProcessing] = useState(false)

  // 登记供应商付款
  const [payDialogOpen, setPayDialogOpen] = useState(false)
  const [paySupplier, setPaySupplier] = useState('')
  const [payAmount, setPayAmount] = useState('')
  const [payDate, setPayDate] = useState(bizToday())
  const [payNote, setPayNote] = useState('')
  const [payRef, setPayRef] = useState('')   // 付款凭证号/单据号——防重复付款硬约束
  const [paySaving, setPaySaving] = useState(false)

  useEffect(() => {
    async function load() {
      const supabase = createClient()

      // 先检查是否有已保存的报表快照
      const { data: snapshot } = await supabase
        .from('report_snapshots')
        .select('*')
        .eq('report_type', 'supplier_statement')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (snapshot && snapshot.status !== 'draft') {
        // 有已审核/确认的快照，使用快照数据
        setLines((snapshot.line_items as SupplierLine[]) || [])
        setStatus(snapshot.status as ReportStatus)
        setSnapshotId(snapshot.id)
        setCorrections((snapshot.corrections as Record<string, unknown>[]) || [])
        setLoading(false)
        return
      }

      // 没有快照或是草稿 → 从实时数据自动汇总
      // 加载费用（含 数量/单位/单价）+ 供应商付款 + 同步订单（获取内部订单号）
      const [costRes, payList, syncedRes] = await Promise.all([
        fetchAll<Record<string, unknown>>((from, to) => supabase.from('cost_items').select('id, description, amount, currency, exchange_rate, cost_type, supplier, source_module, quantity, unit, unit_price, budget_order_id, delivery_date, created_at, budget_orders(order_no, quote_no)').is('deleted_at', null).order('created_at', { ascending: false }).order('id', { ascending: true }).range(from, to)),
        getSupplierPayments(),
        // F7: 节拍器同步订单 — 用于把 cost_items 关联到内部订单号 (style_no)
        fetchAll<Record<string, unknown>>((from, to) => supabase.from('synced_orders').select('budget_order_id, order_no, style_no').not('budget_order_id', 'is', null).order('budget_order_id', { ascending: true }).range(from, to)),
      ])
      const costItems = costRes.data
      const syncedOrders = syncedRes.data || []
      // 归一化付款的供应商名（去全/半角、空格差异），保证与费用侧匹配一致
      const normPayList = payList.map(p => ({ ...p, supplier_name: normalizeSupplierName(p.supplier_name) }))
      setPayments(normPayList)

      // budget_order_id → { internal_no (style_no), metronome_no (order_no) }
      const syncMap = new Map<string, { internal_no: string; metronome_no: string }>()
      syncedOrders.forEach(s => {
        if (s.budget_order_id) {
          syncMap.set(s.budget_order_id as string, {
            internal_no: (s.style_no as string) || '',
            metronome_no: (s.order_no as string) || '',
          })
        }
      })

      // 付款（已登记的供应商付款）按供应商汇总 — 对账单的「已付」以此为准
      const paidMap = new Map<string, number>()
      normPayList.forEach(p => {
        paidMap.set(p.supplier_name, (paidMap.get(p.supplier_name) || 0) + (Number(p.amount) || 0))
      })

      if (costItems?.length) {
        // 保存明细（用于导出 + 展开台账）
        setAllCostDetails(costItems.map(item => {
          const budgetOrderId = item.budget_order_id as string
          const sync = budgetOrderId ? syncMap.get(budgetOrderId) : null
          const bo = item.budget_orders as unknown as { order_no?: string; quote_no?: string } | null
          const quoteFallback = bo?.quote_no ? String(bo.quote_no).trim() : ''
          // 统一折算为人民币（费用可能为外币）：金额 × 汇率。付款侧为人民币登记。CNY 行恒按 1。
          const rate = (item.currency as string) === 'CNY' ? 1 : (Number(item.exchange_rate) || 1)
          const amountCny = Math.round((Number(item.amount) || 0) * rate * 100) / 100
          return {
            supplier: normalizeSupplierName(item.supplier as string) || '未指定',
            description: item.description as string,
            amount: amountCny,
            currency: 'CNY',
            cost_type: item.cost_type as string,
            order_no: bo?.order_no || '',
            internal_no: sync?.internal_no || quoteFallback,
            metronome_no: sync?.metronome_no || '',
            created_at: (item.delivery_date as string) || (item.created_at as string), // 送货日期优先（财务对账口径）
            is_paid: (item.source_module as string) === 'paid',
            unit: (item.unit as string) || '',
            qty: item.quantity != null ? Number(item.quantity) : null,
            unit_price: item.unit_price != null ? Number(item.unit_price) : null,
          }
        }))

        // 按供应商汇总（已付 = 已登记付款合计；未付 = 费用合计 − 付款合计）
        const supplierMap = new Map<string, { count: number; total: number; currency: string; orders: Set<string> }>()

        for (const item of costItems) {
          const supplier = normalizeSupplierName(item.supplier as string) || (item.description as string || '').split(' - ')[0] || '未指定供应商'
          const boRow = item.budget_orders as unknown as { order_no?: string } | null
          const orderNo = boRow?.order_no || ''
          const rate = (item.currency as string) === 'CNY' ? 1 : (Number(item.exchange_rate) || 1)
          const amountCny = (Number(item.amount) || 0) * rate

          const existing = supplierMap.get(supplier) || { count: 0, total: 0, currency: 'CNY', orders: new Set<string>() }
          existing.count++
          existing.total += amountCny
          if (orderNo) existing.orders.add(orderNo)
          supplierMap.set(supplier, existing)
        }

        const result: SupplierLine[] = Array.from(supplierMap.entries())
          .map(([supplier, data]) => {
            const paid = paidMap.get(supplier) || 0
            return {
              supplier,
              count: data.count,
              total: Math.round(data.total * 100) / 100,
              paid: Math.round(paid * 100) / 100,
              unpaid: Math.round((data.total - paid) * 100) / 100,
              currency: data.currency,
              orders: Array.from(data.orders),
            }
          })
          .sort((a, b) => b.total - a.total)

        setLines(result)
      }

      setLoading(false)
    }
    load()
  }, [])

  // 已确认/锁定的快照保持冻结数据；草稿模式按日期实时聚合（与展开明细口径一致）
  const periodAwareLines = useMemo<SupplierLine[]>(() => {
    if (status !== 'draft' || allCostDetails.length === 0) {
      return lines  // 快照模式或还没加载完 → 用原始 lines
    }
    // 用日期范围过滤明细，再按供应商重聚合
    const inRange = allCostDetails.filter(d => {
      if (dateStart && d.created_at < dateStart) return false
      if (dateEnd && d.created_at > dateEnd + 'T23:59:59') return false
      return true
    })
    // 已登记付款（按日期过滤）按供应商汇总
    const payMap = new Map<string, number>()
    for (const p of payments) {
      const d = p.paid_at || ''
      if (dateStart && d && d < dateStart) continue
      if (dateEnd && d && d > dateEnd) continue
      payMap.set(p.supplier_name, (payMap.get(p.supplier_name) || 0) + (Number(p.amount) || 0))
    }
    const map = new Map<string, { count: number; total: number; currency: string; orders: Set<string> }>()
    for (const d of inRange) {
      const existing = map.get(d.supplier) || { count: 0, total: 0, currency: d.currency, orders: new Set<string>() }
      existing.count++
      existing.total += d.amount
      if (d.order_no) existing.orders.add(d.order_no)
      map.set(d.supplier, existing)
    }
    // 包含「只有付款、没有当期费用」的供应商
    for (const sup of payMap.keys()) {
      if (!map.has(sup)) map.set(sup, { count: 0, total: 0, currency: 'CNY', orders: new Set<string>() })
    }
    // 手工修正叠加：草稿态实时重算会覆盖掉 handleCorrection 写入 lines 的修正——
    // 这里按供应商把最新修正(field='total')的 new_value 叠加回来，修正才可见(审计 P1)
    const corrBySupplier = new Map<string, number>()
    for (const c of corrections) {
      if ((c.field as string) === 'total' && c.supplier) corrBySupplier.set(String(c.supplier), Number(c.new_value))
    }
    return Array.from(map.entries())
      .map(([supplier, data]) => {
        const paid = payMap.get(supplier) || 0
        const corrected = corrBySupplier.get(supplier)
        const total = corrected != null ? corrected : Math.round(data.total * 100) / 100
        return {
          supplier,
          count: data.count,
          total,
          paid: Math.round(paid * 100) / 100,
          unpaid: Math.round((total - paid) * 100) / 100,
          currency: data.currency,
          orders: Array.from(data.orders),
          isEdited: corrected != null,
        }
      })
      .sort((a, b) => b.unpaid - a.unpaid)
  }, [allCostDetails, payments, dateStart, dateEnd, status, lines, corrections])

  const filtered = periodAwareLines.filter(s => !search || s.supplier.toLowerCase().includes(search.toLowerCase()))
  const totalAll = filtered.reduce((s, d) => s + d.total, 0)
  const unpaidAll = filtered.reduce((s, d) => s + d.unpaid, 0)
  const isLocked = status === 'locked' || status === 'confirmed'

  const getDetails = (supplier: string) => allCostDetails.filter(d => {
    if (d.supplier !== supplier) return false
    if (dateStart && d.created_at < dateStart) return false
    if (dateEnd && d.created_at > dateEnd + 'T23:59:59') return false
    return true
  })

  const getPaymentsForSupplier = (supplier: string) => payments.filter(p => {
    if (p.supplier_name !== supplier) return false
    const d = p.paid_at || ''
    if (dateStart && d && d < dateStart) return false
    if (dateEnd && d && d > dateEnd) return false
    return true
  })

  // 供应商台账：费用(+) 与 付款(−) 合并、按日期排序、滚动累计余额
  type LedgerRow = { date: string; kind: 'charge' | 'payment'; internal_no: string; description: string; unit: string; qty: number | null; unit_price: number | null; delta: number; balance: number }
  const buildLedger = (supplier: string): LedgerRow[] => {
    const charges = getDetails(supplier).map(d => ({
      date: (d.created_at || '').slice(0, 10), kind: 'charge' as const,
      internal_no: d.internal_no || d.order_no || '', description: d.description || '',
      unit: d.unit || '', qty: d.qty, unit_price: d.unit_price, delta: d.amount || 0,
    }))
    const pays = getPaymentsForSupplier(supplier).map(p => ({
      date: (p.paid_at || '').slice(0, 10), kind: 'payment' as const,
      internal_no: '', description: p.note ? `付款 ${p.note}` : '付款',
      unit: '', qty: null, unit_price: null, delta: -(Number(p.amount) || 0),
    }))
    const merged = [...charges, ...pays].sort((a, b) => {
      if (a.date !== b.date) return (a.date || '0').localeCompare(b.date || '0')
      if (a.kind !== b.kind) return a.kind === 'charge' ? -1 : 1
      return 0
    })
    let running = 0
    return merged.map(m => { running += m.delta; return { ...m, balance: Math.round(running * 100) / 100 } })
  }

  // 保存快照
  const saveSnapshot = async (newStatus: ReportStatus) => {
    setProcessing(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // 落库口径与页面一致：保存当前展示的对账行(含日期区间+修正叠加)，
    // total 用同一份行的合计——此前 line_items=lines(全量) 与 total=totalAll(搜索过滤)
    // 口径不一致，快照自相矛盾(审计 P2)
    const snapLines = periodAwareLines
    const snapTotal = Math.round(snapLines.reduce((s, l) => s + l.total, 0) * 100) / 100
    const snapshotData: Record<string, unknown> = {
      report_type: 'supplier_statement',
      report_title: `供应商对账单 ${new Date().toLocaleDateString('zh-CN')}`,
      line_items: snapLines,
      total_amount: snapTotal,
      currency: 'CNY',
      status: newStatus,
      corrections,
      correction_count: corrections.length,
    }

    if (newStatus === 'reviewing') {
      snapshotData.generated_by = user?.id
    }
    if (newStatus === 'confirmed') {
      snapshotData.confirmed_by = user?.id
      snapshotData.confirmed_at = new Date().toISOString()
    }
    if (newStatus === 'reviewing') {
      snapshotData.reviewed_by = user?.id
      snapshotData.reviewed_at = new Date().toISOString()
    }

    if (snapshotId) {
      const { error } = await supabase.from('report_snapshots').update(snapshotData).eq('id', snapshotId)
      if (error) { toast.error(`保存失败: ${error.message}`); setProcessing(false); return }
    } else {
      const { data, error } = await supabase.from('report_snapshots').insert(snapshotData).select('id').single()
      if (error) { toast.error(`保存失败: ${error.message}`); setProcessing(false); return }
      if (data) setSnapshotId(data.id)
    }

    setStatus(newStatus)
    setProcessing(false)

    const labels: Record<string, string> = { reviewing: '已提交审核', confirmed: '已确认', locked: '已锁定' }
    toast.success(labels[newStatus] || '已保存')
  }

  // 修正金额
  const handleCorrection = () => {
    if (!editDialog || !editReason.trim()) { toast.error('请填写修正原因'); return }

    const newLines = [...lines]
    // 必须按供应商名定位：editDialog.index 是「过滤+排序后视图」的下标，
    // 与 lines（按总额排序的全量）下标不同，直接用会把修正写到别的供应商头上
    const idx = newLines.findIndex(l => l.supplier === editDialog.line.supplier)
    if (idx < 0) { toast.error('未找到该供应商行，请刷新后重试'); return }
    const oldTotal = newLines[idx].total
    const newTotal = Number(editAmount)

    if (isNaN(newTotal)) { toast.error('请输入有效金额'); return }

    newLines[idx] = {
      ...newLines[idx],
      total: newTotal,
      unpaid: newTotal - newLines[idx].paid,
      isEdited: true,
      editNote: editReason,
    }
    setLines(newLines)

    setCorrections([...corrections, {
      line_index: idx,
      supplier: editDialog.line.supplier,
      field: 'total',
      old_value: oldTotal,
      new_value: newTotal,
      reason: editReason,
      corrected_by: user?.id || null,   // 真实登录人(此前硬编码 'current_user' 审计失真)
      corrected_at: new Date().toISOString(),
    }])

    setEditDialog(null)
    setEditAmount('')
    setEditReason('')
    toast.success('已修正')
  }

  // 登记供应商付款（负数流水）。force=用户在"疑似重复"提示后仍确认登记
  const handleAddPayment = async (force = false) => {
    const sup = normalizeSupplierName(paySupplier)
    const amt = Number(payAmount)
    if (!sup) { toast.error('请填写供应商'); return }
    if (!amt || amt <= 0) { toast.error('请输入有效付款金额'); return }
    setPaySaving(true)
    const { data, error, duplicate, blocked } = await createSupplierPayment({
      supplier_name: sup, amount: amt, paid_at: payDate || null, note: payNote.trim() || null, payment_ref: payRef.trim() || null, force,
    })
    setPaySaving(false)
    // 硬拦(不可 force)：同额已由系统通道出款 / force 缺凭证号 → 直接报错，不给绕过入口
    if (blocked) { toast.error(error || '该付款已被系统拦下(疑似双记)'); return }
    // 防重复付款：命中疑似重复 → 弹确认，列出已有的同额付款，用户确认非重复才 force 登记
    if (duplicate && duplicate.length > 0) {
      const list = duplicate.map(d => `· ${d.currency} ${Number(d.amount).toLocaleString()}${d.paid_at ? ' 付于 ' + String(d.paid_at).slice(0, 10) : ''}${d.note ? '（' + String(d.note).slice(0, 20) + '）' : ''}`).join('\n')
      if (confirm(`⚠ 疑似重复付款！\n\n「${sup}」近90天已有 ${duplicate.length} 笔同额同币种付款：\n${list}\n\n确认这是另一笔、不是重复付款吗？确认则继续登记。`)) {
        return handleAddPayment(true)   // 用户确认非重复 → force 登记
      }
      return   // 用户取消 → 不登记
    }
    if (error || !data) { toast.error(`登记失败: ${error || '未知错误'}`); return }
    setPayments([...payments, { ...data, supplier_name: normalizeSupplierName(data.supplier_name) }])
    // 付款登记 → GL 受控灰度：入队生成「应付/银行」草稿凭证（非阻塞；
    // 失败进异常中心，不影响付款登记，可后续重试/复核过账）
    fetch('/api/gl/queue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessEvent: 'payment_registered', sourceType: 'supplier_payment', sourceId: data.id }),
    }).catch(err => console.error('[GL] 付款入队失败:', err))
    toast.success(`已登记付款 ${sup} ¥${amt.toLocaleString()}`)
    setPayDialogOpen(false)
    setPaySupplier(''); setPayAmount(''); setPayNote(''); setPayDate(bizToday())
  }

  const handleDeletePayment = async (id: string) => {
    if (!confirm('确定删除这笔付款记录？对账单余额会相应回升。')) return
    const { error } = await deleteSupplierPayment(id)
    if (error) { toast.error(`删除失败: ${error}`); return }
    setPayments(payments.filter(p => p.id !== id))
    toast.success('付款记录已删除')
  }

  // 供应商候选（供登记付款下拉）
  const supplierOptions = Array.from(new Set(allCostDetails.map(d => d.supplier).filter(Boolean))).sort()

  return (
    <div className="flex flex-col h-full">
      <Header title="供应商对账单" subtitle="自动汇总 → 方圆审核 → Su确认 → 锁定导出" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">

        {/* 状态条 */}
        <Card className="border-l-4 border-l-primary">
          <CardContent className="p-3 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Badge className={`${STATUS_CONFIG[status].color} border-0`}>{STATUS_CONFIG[status].label}</Badge>
              {corrections.length > 0 && <Badge variant="secondary" className="text-[10px]">{corrections.length}处修正</Badge>}
              <span className="text-xs text-muted-foreground">{lines.length}个供应商 · 总金额 ¥{totalAll.toLocaleString()}</span>
            </div>
            <div className="flex gap-2">
              {status === 'draft' && (
                <Button size="sm" onClick={() => saveSnapshot('reviewing')} disabled={processing || lines.length === 0}>
                  {processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                  提交审核(方圆)
                </Button>
              )}
              {status === 'reviewing' && (
                <Button size="sm" onClick={() => saveSnapshot('confirmed')} disabled={processing}>
                  {processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                  确认(Su签字)
                </Button>
              )}
              {status === 'confirmed' && (
                <Button size="sm" variant="outline" onClick={() => saveSnapshot('locked')} disabled={processing}>
                  <Lock className="h-4 w-4 mr-1" />锁定
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => { setPaySupplier(''); setPayAmount(''); setPayNote(''); setPayDate(bizToday()); setPayDialogOpen(true) }}>
                <Plus className="h-4 w-4 mr-1" />登记付款
              </Button>
              {/* F5: 导出按钮去掉状态门槛 — draft 也能导 */}
              {/* 流水台账格式：费用(+) / 付款(−) / 累计余额=实际未付 */}
              <Button
                size="sm"
                variant="default"
                onClick={() => {
                  // 仅导出 已选搜索/日期范围内 + filtered 供应商的费用与付款
                  const supplierSet = new Set(filtered.map(f => f.supplier))
                  const chargesToExport = allCostDetails.filter(d => {
                    if (!supplierSet.has(d.supplier)) return false
                    if (dateStart && d.created_at < dateStart) return false
                    if (dateEnd && d.created_at > dateEnd + 'T23:59:59') return false
                    return true
                  }).map(d => ({
                    supplier: d.supplier, date: d.created_at, internal_no: d.internal_no,
                    description: d.description, unit: d.unit, qty: d.qty, unit_price: d.unit_price, amount: d.amount,
                  }))
                  const paymentsToExport = payments.filter(p => {
                    if (!supplierSet.has(p.supplier_name)) return false
                    const dt = p.paid_at || ''
                    if (dateStart && dt && dt < dateStart) return false
                    if (dateEnd && dt && dt > dateEnd) return false
                    return true
                  }).map(p => ({ supplier: p.supplier_name, date: p.paid_at || '', amount: Number(p.amount) || 0, note: p.note || '' }))
                  if (chargesToExport.length === 0 && paymentsToExport.length === 0) {
                    toast.error('当前条件下没有可导出的费用或付款')
                    return
                  }
                  exportSupplierStatementToExcel(
                    chargesToExport,
                    paymentsToExport,
                    { start: dateStart || '', end: dateEnd || '' }
                  )
                  toast.success(`已导出 ${supplierSet.size} 个供应商对账单（费用 ${chargesToExport.length} 笔 · 付款 ${paymentsToExport.length} 笔）`)
                }}
                disabled={filtered.length === 0}
              >
                <Download className="h-4 w-4 mr-1" />导出对账单
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (filtered.length === 0) {
                    toast.error('当前条件下没有数据可导出')
                    return
                  }
                  exportCostSummaryReport(
                    filtered.map(s => ({ category: s.supplier, count: s.count, amount: s.total, currency: s.currency })),
                    { start: dateStart || '全部', end: dateEnd || '全部' }
                  )
                  toast.success(`已导出 ${filtered.length} 个供应商的汇总表`)
                }}
                disabled={filtered.length === 0}
              >
                <Download className="h-4 w-4 mr-1" />导出汇总表
              </Button>
              {status !== 'draft' && status !== 'locked' && (
                <Button size="sm" variant="ghost" onClick={async () => {
                  // 落库(此前只改前端 state,刷新后自动弹回 reviewing/confirmed——审计 P1)
                  if (snapshotId) {
                    const { error } = await createClient().from('report_snapshots').update({ status: 'draft' }).eq('id', snapshotId)
                    if (error) { toast.error(`退回失败: ${error.message}`); return }
                  }
                  setStatus('draft'); toast.info('已退回草稿')
                }}>
                  退回草稿
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 流程指引 */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={status === 'draft' ? 'text-primary font-medium' : ''}>① 系统自动汇总</span>
          <span>→</span>
          <span className={status === 'reviewing' ? 'text-primary font-medium' : ''}>② 方圆逐笔核对</span>
          <span>→</span>
          <span className={status === 'confirmed' ? 'text-primary font-medium' : ''}>③ Su确认签字</span>
          <span>→</span>
          <span className={status === 'locked' ? 'text-primary font-medium' : ''}>④ 锁定导出</span>
        </div>

        {/* KPI */}
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-blue-50"><FileText className="h-4 w-4 text-blue-600" /></div><div><p className="text-xs text-muted-foreground">供应商数</p><p className="text-xl font-bold">{filtered.length}</p></div></CardContent></Card>
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-green-50"><DollarSign className="h-4 w-4 text-green-600" /></div><div><p className="text-xs text-muted-foreground">总金额</p><p className="text-xl font-bold">¥{totalAll.toLocaleString()}</p></div></CardContent></Card>
          <Card className={unpaidAll > 0 ? 'border-amber-200' : ''}><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-amber-50"><Clock className="h-4 w-4 text-amber-600" /></div><div><p className="text-xs text-muted-foreground">待付金额</p><p className="text-xl font-bold text-amber-600">¥{unpaidAll.toLocaleString()}</p></div></CardContent></Card>
        </div>

        {/* 搜索 + 日期筛选 */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="搜索供应商..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <span className="text-muted-foreground">明细日期</span>
            <Input type="date" value={dateStart} onChange={e => setDateStart(e.target.value)} className="w-36 h-9" />
            <span className="text-muted-foreground">~</span>
            <Input type="date" value={dateEnd} onChange={e => setDateEnd(e.target.value)} className="w-36 h-9" />
            {/* 快捷按钮：避免每次手动选日期 */}
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => {
              const end = new Date()
              const start = new Date(); start.setDate(start.getDate() - 30)
              setDateStart(start.toISOString().slice(0, 10))
              setDateEnd(end.toISOString().slice(0, 10))
            }}>近30天</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => {
              const end = new Date()
              const start = new Date(); start.setDate(start.getDate() - 90)
              setDateStart(start.toISOString().slice(0, 10))
              setDateEnd(end.toISOString().slice(0, 10))
            }}>近90天</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => {
              setDateStart(''); setDateEnd('')
            }}>全部</Button>
          </div>
        </div>

        {/* 数据缺失提示：明明加载完但表格空 */}
        {!loading && filtered.length === 0 && allCostDetails.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>当前日期范围内没有费用记录（共 {allCostDetails.length} 条费用，跨多个时段）。点"全部"或调整日期看完整数据。</span>
          </div>
        )}

        {/* 表格 */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground"><FileText className="h-12 w-12 mx-auto mb-3 opacity-30" /><p>暂无数据</p><p className="text-xs mt-1">请先在费用归集中录入费用</p></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>供应商</TableHead>
                    <TableHead className="text-center">笔数</TableHead>
                    <TableHead className="text-right">总金额</TableHead>
                    <TableHead className="text-right">已付</TableHead>
                    <TableHead className="text-right">待付</TableHead>
                    <TableHead>关联订单</TableHead>
                    <TableHead>状态</TableHead>
                    {!isLocked && <TableHead className="text-center">修正</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((s, i) => {
                    const ledger = buildLedger(s.supplier)
                    const isExpanded = expandedSupplier === s.supplier
                    return (
                      <React.Fragment key={i}>
                        <TableRow className={`cursor-pointer hover:bg-muted/50 ${s.isEdited ? 'bg-amber-50/50' : ''}`} onClick={() => setExpandedSupplier(isExpanded ? null : s.supplier)}>
                          <TableCell className="font-medium">
                            <span className="mr-1">{isExpanded ? '▼' : '▶'}</span>
                            {s.supplier}
                            {s.isEdited && <Badge variant="secondary" className="ml-1 text-[9px]">已修正</Badge>}
                          </TableCell>
                          <TableCell className="text-center">{s.count}</TableCell>
                          <TableCell className="text-right font-semibold">¥{s.total.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-green-600">¥{s.paid.toLocaleString()}</TableCell>
                          <TableCell className={`text-right font-semibold ${s.unpaid > 0 ? 'text-amber-600' : 'text-green-600'}`}>¥{s.unpaid.toLocaleString()}</TableCell>
                          <TableCell>
                            <div className="flex gap-1 flex-wrap">{s.orders.slice(0, 3).map(o => <Badge key={o} variant="outline" className="text-[10px]">{o}</Badge>)}{s.orders.length > 3 && <span className="text-[10px] text-muted-foreground">+{s.orders.length - 3}</span>}</div>
                          </TableCell>
                          <TableCell><Badge variant={Math.abs(s.unpaid) < 0.01 ? 'default' : 'secondary'} className={Math.abs(s.unpaid) < 0.01 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}>{Math.abs(s.unpaid) < 0.01 ? '已付清' : '未付清'}</Badge></TableCell>
                          {!isLocked && (
                            <TableCell className="text-center" onClick={e => e.stopPropagation()}>
                              <Button size="sm" variant="ghost" className="h-7" onClick={() => { setEditDialog({ index: i, line: s }); setEditAmount(s.total.toString()) }}>
                                <Edit className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                        {/* 展开流水台账：费用(+) / 付款(−) / 累计余额 */}
                        {isExpanded && (
                          <TableRow>
                            <TableCell colSpan={isLocked ? 7 : 8} className="p-0 bg-slate-50">
                              {ledger.length === 0 ? (
                                <div className="text-center py-4 text-xs text-muted-foreground">该时间段内无记录</div>
                              ) : (
                                <table className="w-full text-xs border-t border-slate-200">
                                  <thead className="bg-slate-100 border-b border-slate-200">
                                    <tr>
                                      <th className="pl-10 pr-3 py-2 text-left font-semibold text-slate-600 w-24">日期</th>
                                      <th className="px-3 py-2 text-left font-semibold text-blue-700 w-28">内部订单号</th>
                                      <th className="px-2 py-2 text-left font-semibold text-slate-600">摘要</th>
                                      <th className="px-2 py-2 text-left font-semibold text-slate-600 w-12">单位</th>
                                      <th className="px-2 py-2 text-right font-semibold text-slate-600 w-16">数量</th>
                                      <th className="px-2 py-2 text-right font-semibold text-slate-600 w-16">单价</th>
                                      <th className="px-2 py-2 text-right font-semibold text-slate-600 w-24">费用(+)</th>
                                      <th className="px-2 py-2 text-right font-semibold text-slate-600 w-24">付款(−)</th>
                                      <th className="px-3 py-2 text-right font-semibold text-slate-700 w-28">累计余额</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {ledger.map((e, di) => (
                                      <tr key={di} className={`border-t border-slate-100 hover:bg-white ${e.kind === 'payment' ? 'bg-green-50/40' : ''}`}>
                                        <td className="pl-10 pr-3 py-1.5 text-muted-foreground">{e.date || '—'}</td>
                                        <td className="px-3 py-1.5 font-mono text-blue-700">{e.internal_no || <span className="text-muted-foreground font-normal">—</span>}</td>
                                        <td className="px-2 py-1.5 text-muted-foreground">{e.description}</td>
                                        <td className="px-2 py-1.5 text-muted-foreground">{e.unit || ''}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums">{e.qty != null ? e.qty.toLocaleString() : ''}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums">{e.unit_price != null ? e.unit_price.toLocaleString() : ''}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums">{e.kind === 'charge' ? `¥${e.delta.toLocaleString()}` : ''}</td>
                                        <td className="px-2 py-1.5 text-right tabular-nums text-green-700">{e.kind === 'payment' ? `−¥${Math.abs(e.delta).toLocaleString()}` : ''}</td>
                                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">¥{e.balance.toLocaleString()}</td>
                                      </tr>
                                    ))}
                                    <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold">
                                      <td className="pl-10 pr-3 py-1.5" colSpan={6}>期末应付（实际未付）</td>
                                      <td className="px-2 py-1.5 text-right tabular-nums">¥{s.total.toLocaleString()}</td>
                                      <td className="px-2 py-1.5 text-right tabular-nums text-green-700">−¥{s.paid.toLocaleString()}</td>
                                      <td className={`px-3 py-1.5 text-right tabular-nums ${s.unpaid > 0 ? 'text-amber-700' : 'text-green-700'}`}>¥{s.unpaid.toLocaleString()}</td>
                                    </tr>
                                  </tbody>
                                </table>
                              )}
                              {/* 该供应商已登记付款（点 × 删除，余额会相应回升） */}
                              {getPaymentsForSupplier(s.supplier).length > 0 && !isLocked && (
                                <div className="px-10 py-2 border-t border-slate-200 bg-white/60 space-y-1">
                                  <p className="text-[10px] text-muted-foreground">已登记付款（点 × 可删除）：</p>
                                  <div className="flex flex-wrap gap-2">
                                    {getPaymentsForSupplier(s.supplier).map(p => (
                                      <span key={p.id} className="inline-flex items-center gap-1 text-[11px] bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
                                        {p.paid_at || '—'} · ¥{Number(p.amount).toLocaleString()}{p.note ? ` · ${p.note}` : ''}
                                        <button className="text-red-400 hover:text-red-600" onClick={(ev) => { ev.stopPropagation(); handleDeletePayment(p.id) }}><Trash2 className="h-3 w-3" /></button>
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* 修正记录 */}
        {corrections.length > 0 && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" />修正记录 ({corrections.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {corrections.map((c, i) => (
                <div key={i} className="flex items-center gap-3 text-xs p-2 bg-amber-50 rounded-lg">
                  <span className="font-medium">{c.supplier as string}</span>
                  <span className="text-muted-foreground">¥{(c.old_value as number)?.toLocaleString()} → ¥{(c.new_value as number)?.toLocaleString()}</span>
                  <span className="text-amber-700">原因: {c.reason as string}</span>
                  <span className="text-muted-foreground ml-auto">{new Date(c.corrected_at as string).toLocaleString('zh-CN')}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {/* 修正弹窗 */}
      {editDialog && (
        <Dialog open={true} onOpenChange={() => setEditDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>修正金额 — {editDialog.line.supplier}</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-muted-foreground">当前金额: </span><span className="font-semibold">¥{editDialog.line.total.toLocaleString()}</span></div>
                <div><span className="text-muted-foreground">笔数: </span>{editDialog.line.count}</div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">修正后金额 *</p>
                <Input type="number" step="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">修正原因 *</p>
                <Textarea placeholder="例：发票金额有误，按实际对账调整" value={editReason} onChange={e => setEditReason(e.target.value)} rows={2} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditDialog(null)}>取消</Button>
              <Button onClick={handleCorrection}>确认修正</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 登记供应商付款弹窗 */}
      <Dialog open={payDialogOpen} onOpenChange={setPayDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>登记供应商付款</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>供应商 *</Label>
              <Input list="supplier-pay-options" placeholder="选择或输入供应商" value={paySupplier} onChange={e => setPaySupplier(e.target.value)} />
              <datalist id="supplier-pay-options">
                {supplierOptions.map(o => <option key={o} value={o} />)}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>付款金额 (¥) *</Label>
                <Input type="number" step="0.01" min={0.01} placeholder="如 200000" value={payAmount} onChange={e => setPayAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>付款日期</Label>
                <Input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>付款凭证号 / 单据号 <span className="text-[11px] text-muted-foreground">（银行流水号/回单号/发票号，防重复付款）</span></Label>
              <Input placeholder="填了则同供应商同凭证号不可重复付款（强烈建议填）" value={payRef} onChange={e => setPayRef(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>备注</Label>
              <Textarea placeholder="付款方式/说明（可选）" value={payNote} onChange={e => setPayNote(e.target.value)} rows={2} />
            </div>
            <p className="text-[11px] text-muted-foreground">付款只挂供应商、不挂订单号。填付款凭证号可从数据库层杜绝重复付款。登记后对账单以负数流水计入，累计余额即实际未付。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayDialogOpen(false)}>取消</Button>
            <Button onClick={() => handleAddPayment()} disabled={paySaving}>
              {paySaving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}登记付款
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
