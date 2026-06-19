'use client'

// ============================================================
// 供应商应付明细（可复用组件）
// 顶部「对账三角」：产生总金额 − 已付金额 = 应付余额（三块均可点击切到对应明细）
// Tab：按品名汇总 / 全部费用明细 / 付款记录 / 未付明细
// 被独立页 [supplier]/page.tsx 与 应付账款左右分栏多标签 共用。
// ============================================================

import { useState, useEffect, useMemo, Fragment } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Loader2, Package, ChevronRight, ChevronDown, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { getSupplierPayments } from '@/lib/supabase/queries-v2'
import { normalizeSupplierName, escapeIlike } from '@/lib/utils'
import type { SupplierPayment } from '@/lib/types'

export interface Line {
  id: string
  supplier?: string
  cost_type: string
  description: string
  orderLabel: string
  color: string | null
  rollCount: number | null
  qty: number | null
  unit: string
  unit_price: number | null
  amountCny: number
  createdAt: string
  agingDays: number
}

const COST_TYPE_LABEL: Record<string, string> = {
  fabric: '面料', accessory: '辅料', processing: '加工费', freight: '货代费',
  container: '装柜费', customs: '报关费', logistics: '物流费', commission: '佣金',
  procurement: '采购', tax: '税费', other: '其他',
}

function daysSince(s: string): number {
  const d = new Date(s)
  if (isNaN(d.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000))
}
const r2 = (n: number) => Math.round(n * 100) / 100

export function SupplierPayableDetail({
  supplierName,
  lines: linesProp,
  payments: paymentsProp,
}: {
  supplierName: string
  lines?: Line[]
  payments?: SupplierPayment[]
}) {
  // 预加载模式：父级（应付工作台）已把数据查好传进来 → 零再请求，点开即显示
  const preloaded = linesProp !== undefined
  const [loading, setLoading] = useState(!preloaded)
  const [fetchedLines, setFetchedLines] = useState<Line[]>([])
  const [fetchedPayments, setFetchedPayments] = useState<SupplierPayment[]>([])
  const lines = preloaded ? linesProp! : fetchedLines
  const payments = preloaded ? (paymentsProp || []) : fetchedPayments
  const [expandedItem, setExpandedItem] = useState<Record<string, boolean>>({})
  // 默认打开「全部费用明细」：财务要求的表头格式（日期-内部订单号-品名-颜色-匹数-
  // 数量-单价-金额-已付款-未付）在此标签页，必须是打开供应商后第一眼看到的视图
  const [tab, setTab] = useState('all')

  useEffect(() => {
    if (preloaded) return  // 已有预加载数据，不查库
    async function load() {
      setLoading(true)
      try {
        const supabase = createClient()
        const like = `%${escapeIlike(supplierName)}%`
        // 1) 先取该供应商的费用 + 付款（费用用 ilike 缩到本供应商，避免全表）
        const [costRes, payList] = await Promise.all([
          fetchAll<Record<string, unknown>>((from, to) => supabase
            .from('cost_items')
            .select('id, cost_type, description, supplier, amount, currency, exchange_rate, quantity, unit, unit_price, color, roll_count, source_id, budget_order_id, delivery_date, created_at, budget_orders(order_no, quote_no)')
            .is('deleted_at', null)
            .ilike('supplier', like)
            .order('created_at', { ascending: true }).order('id', { ascending: true })
            .range(from, to)),
          getSupplierPayments({ supplierName }),
        ])

        const costData = (costRes.data || []).filter((c: Record<string, unknown>) => normalizeSupplierName(c.supplier as string) === supplierName)

        // 2) 只为相关订单取 synced_orders（按 budget_order_id 过滤，避免拉全表 → 修卡顿）
        const boIds = [...new Set(costData.map((c: Record<string, unknown>) => c.budget_order_id as string).filter(Boolean))]
        const syncMap = new Map<string, string>()
        if (boIds.length > 0) {
          const { data: synced } = await supabase.from('synced_orders').select('budget_order_id, style_no').in('budget_order_id', boIds)
          ;(synced || []).forEach((s: Record<string, unknown>) => {
            if (s.budget_order_id && s.style_no) syncMap.set(s.budget_order_id as string, String(s.style_no))
          })
        }

        const ls: Line[] = costData
          .map((c: Record<string, unknown>) => {
            const boId = c.budget_order_id as string | null
            const bo = c.budget_orders as { order_no?: string; quote_no?: string } | null
            const quoteFallback = bo?.quote_no ? String(bo.quote_no).trim() : ''
            const orderLabel = boId ? (syncMap.get(boId) || quoteFallback || bo?.order_no || '') : ''
            const rate = (c.currency as string) === 'CNY' ? 1 : (Number(c.exchange_rate) || 1)
            let qty = c.quantity != null ? Number(c.quantity) : null
            let unit = (c.unit as string) || ''
            let price = c.unit_price != null ? Number(c.unit_price) : null
            if (qty == null && typeof c.source_id === 'string') {
              try {
                const j = JSON.parse(c.source_id as string)
                if (j && typeof j === 'object') { qty = j.qty ?? j.quantity ?? null; unit = unit || j.unit || ''; price = price ?? j.unit_price ?? j.price ?? null }
              } catch { /* not json */ }
            }
            return {
              id: c.id as string,
              cost_type: (c.cost_type as string) || '',
              description: (c.description as string) || '',
              orderLabel,
              color: (c.color as string) || null,
              rollCount: c.roll_count != null ? Number(c.roll_count) : null,
              qty, unit, unit_price: price,
              amountCny: r2((Number(c.amount) || 0) * rate),
              createdAt: (c.delivery_date as string) || (c.created_at as string), // 送货日期优先（财务对账口径）
              agingDays: daysSince(c.created_at as string),
            }
          })
        setFetchedLines(ls)
        setFetchedPayments((payList || []).filter(p => normalizeSupplierName(p.supplier_name) === supplierName))
      } catch (e) {
        console.error('加载供应商应付明细失败:', e)
      }
      setLoading(false)
    }
    load()
  }, [supplierName, preloaded])

  const summary = useMemo(() => {
    const totalCharge = r2(lines.reduce((s, l) => s + l.amountCny, 0))
    const paid = r2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0))
    const unpaid = r2(totalCharge - paid)
    const orders = [...new Set(lines.map(l => l.orderLabel).filter(Boolean))]
    let remaining = paid
    let oldestAging = 0
    for (const l of lines) {
      if (remaining >= l.amountCny - 0.005) { remaining -= l.amountCny; continue }
      oldestAging = l.agingDays; break
    }
    return { totalCharge, paid, unpaid, count: lines.length, orderCount: orders.length, oldestAging }
  }, [lines, payments])

  const byItem = useMemo(() => {
    const map = new Map<string, { name: string; cost_type: string; units: Map<string, number>; amount: number; rows: Line[] }>()
    for (const l of lines) {
      const name = l.description.trim() || '(未命名)'
      const key = `${l.cost_type}||${name}`
      const slot = map.get(key) || { name, cost_type: l.cost_type, units: new Map<string, number>(), amount: 0, rows: [] }
      slot.amount += l.amountCny
      slot.rows.push(l)
      if (l.qty != null) slot.units.set(l.unit || '', (slot.units.get(l.unit || '') || 0) + l.qty)
      map.set(key, slot)
    }
    return [...map.entries()].map(([key, v]) => {
      const totalQty = [...v.units.values()].reduce((s, x) => s + x, 0)
      const qtyLabel = [...v.units.entries()].filter(([, q]) => q).map(([u, q]) => `${r2(q)}${u || ''}`).join(' + ') || '—'
      const dates = v.rows.map(r => r.createdAt).filter(Boolean).sort()
      const firstDate = dates[0] || ''
      const lastDate = dates[dates.length - 1] || ''
      return { key, name: v.name, cost_type: v.cost_type, qtyLabel, amount: r2(v.amount), price: totalQty > 0 ? r2(v.amount / totalQty) : null, rows: v.rows, firstDate, lastDate }
    }).sort((a, b) => (a.firstDate || '').localeCompare(b.firstDate || ''))
  }, [lines])

  const unpaidLines = useMemo(() => {
    let remaining = summary.paid
    const out: (Line & { unpaidPortion: number })[] = []
    for (const l of lines) {
      if (remaining >= l.amountCny - 0.005) { remaining -= l.amountCny; continue }
      out.push({ ...l, unpaidPortion: r2(l.amountCny - remaining) })
      remaining = 0
    }
    return out
  }, [lines, summary.paid])

  // 每笔费用的已付/未付（FIFO：付款先冲抵最早费用）
  const allocatedLines = useMemo(() => {
    let remaining = summary.paid
    return lines.map(l => {
      const paid = Math.min(remaining, l.amountCny)
      remaining = Math.max(0, remaining - l.amountCny)
      return { ...l, paidPortion: r2(paid), unpaidPortion: r2(l.amountCny - paid) }
    })
  }, [lines, summary.paid])

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>

  const isCleared = summary.unpaid <= 0.005

  return (
    <div className="p-4 md:p-5 space-y-5">
      <div className="flex items-center justify-end">
        <Link href={`/reports/supplier?q=${encodeURIComponent(supplierName)}`}>
          <Button variant="outline" size="sm"><Wallet className="h-4 w-4 mr-1" />去登记付款 / 对账单</Button>
        </Link>
      </div>

      {/* 对账三角：产生总额 − 已付 = 应付（三块均可点击查看明细） */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className={`cursor-pointer transition hover:shadow-md hover:border-primary/40 ${tab === 'all' ? 'border-primary ring-1 ring-primary/30' : ''}`} onClick={() => setTab('all')}>
          <CardContent className="p-5">
            <p className="text-xs text-muted-foreground">产生总金额（费用合计）</p>
            <p className="text-2xl font-bold mt-1">¥{summary.totalCharge.toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground mt-1">{summary.count} 笔费用 · {summary.orderCount} 个关联订单 · <span className="text-primary">点击看明细 →</span></p>
          </CardContent>
        </Card>
        <Card className={`cursor-pointer transition hover:shadow-md hover:border-primary/40 ${tab === 'payments' ? 'border-primary ring-1 ring-primary/30' : ''}`} onClick={() => setTab('payments')}>
          <CardContent className="p-5">
            <p className="text-xs text-muted-foreground">已付金额（已登记付款）</p>
            <p className="text-2xl font-bold mt-1 text-green-600">−¥{summary.paid.toLocaleString()}</p>
            <p className="text-[11px] text-muted-foreground mt-1">{payments.length} 笔付款 · <span className="text-primary">点击看明细 →</span></p>
          </CardContent>
        </Card>
        <Card className={`cursor-pointer transition hover:shadow-md ${tab === 'unpaid' ? 'ring-1 ring-primary/40' : ''} ${isCleared ? 'border-green-200 bg-green-50/40' : 'border-red-200 bg-red-50/40'}`} onClick={() => setTab('unpaid')}>
          <CardContent className="p-5">
            <p className="text-xs text-muted-foreground">应付余额（实际未付）</p>
            <p className={`text-2xl font-bold mt-1 ${isCleared ? 'text-green-700' : 'text-red-600'}`}>
              {isCleared && summary.unpaid < -0.005 ? `多付 ¥${Math.abs(summary.unpaid).toLocaleString()}` : `¥${summary.unpaid.toLocaleString()}`}
            </p>
            <p className="text-[11px] mt-1 flex items-center gap-2">
              {isCleared ? <Badge className="bg-green-100 text-green-700">已结清</Badge>
                : <span className={summary.oldestAging > 60 ? 'text-red-600 font-medium' : 'text-muted-foreground'}>最长账龄 {summary.oldestAging} 天</span>}
              <span className="text-primary">点击看明细 →</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="byitem">按品名汇总 ({byItem.length})</TabsTrigger>
          <TabsTrigger value="all">全部费用明细 ({lines.length})</TabsTrigger>
          <TabsTrigger value="payments">付款记录 ({payments.length})</TabsTrigger>
          <TabsTrigger value="unpaid">未付明细 ({unpaidLines.length})</TabsTrigger>
        </TabsList>

        {/* 按品名汇总 */}
        <TabsContent value="byitem" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2"><Package className="h-4 w-4 text-primary" />按品名汇总（核对供应商送货）</CardTitle>
              <p className="text-xs text-muted-foreground">按「送货日期」排序；同一品名跨多笔/多单累加数量（如 黑色总公斤、吊牌总件数）；点开看每一笔。</p>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[160px]">品名</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>送货日期</TableHead>
                    <TableHead className="text-right">数量合计</TableHead>
                    <TableHead className="text-right">单价(约)</TableHead>
                    <TableHead className="text-right">金额(¥)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byItem.map(it => {
                    const open = !!expandedItem[it.key]
                    const dRange = it.firstDate
                      ? (it.firstDate === it.lastDate
                          ? new Date(it.firstDate).toLocaleDateString('zh-CN')
                          : `${new Date(it.firstDate).toLocaleDateString('zh-CN')} ~ ${new Date(it.lastDate).toLocaleDateString('zh-CN')}`)
                      : '—'
                    return (
                      <Fragment key={it.key}>
                        <TableRow className="cursor-pointer hover:bg-muted/40" onClick={() => setExpandedItem(p => ({ ...p, [it.key]: !p[it.key] }))}>
                          <TableCell className="font-medium">
                            <span className="inline-flex items-center gap-1">
                              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                              {it.name}
                              {it.rows.length > 1 && <span className="text-[10px] text-muted-foreground">({it.rows.length}笔)</span>}
                            </span>
                          </TableCell>
                          <TableCell><span className="text-xs text-muted-foreground">{COST_TYPE_LABEL[it.cost_type] || it.cost_type}</span></TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{dRange}</TableCell>
                          <TableCell className="text-right font-medium">{it.qtyLabel}</TableCell>
                          <TableCell className="text-right text-muted-foreground">{it.price != null ? `¥${it.price}` : '—'}</TableCell>
                          <TableCell className="text-right font-medium">¥{it.amount.toLocaleString()}</TableCell>
                        </TableRow>
                        {open && it.rows.map(r => (
                          <TableRow key={r.id} className="bg-muted/20">
                            <TableCell className="pl-9 text-xs">
                              <span className="text-[10px] text-muted-foreground">单号 </span>
                              <span className="text-foreground font-medium">{r.orderLabel || '无单号'}</span>
                            </TableCell>
                            <TableCell />
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(r.createdAt).toLocaleDateString('zh-CN')}</TableCell>
                            <TableCell className="text-right text-xs">{r.qty != null ? `${r.qty}${r.unit || ''}` : '—'}</TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">{r.unit_price != null ? `¥${r.unit_price}` : '—'}</TableCell>
                            <TableCell className="text-right text-xs">¥{r.amountCny.toLocaleString()}</TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    )
                  })}
                  {byItem.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">暂无费用明细</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 全部费用明细：日期/内部订单号/品名/颜色/匹数/数量/单价/金额/已付款/未付 */}
        <TabsContent value="all" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">日期</TableHead>
                    <TableHead>内部订单号</TableHead>
                    <TableHead className="min-w-[120px]">品名</TableHead>
                    <TableHead>颜色</TableHead>
                    <TableHead className="text-right">匹数</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">单价</TableHead>
                    <TableHead className="text-right">金额(¥)</TableHead>
                    <TableHead className="text-right">已付款</TableHead>
                    <TableHead className="text-right">未付</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allocatedLines.map(l => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(l.createdAt).toLocaleDateString('zh-CN')}</TableCell>
                      <TableCell className="text-xs">{l.orderLabel || '—'}</TableCell>
                      <TableCell className="text-sm">{l.description}</TableCell>
                      <TableCell className="text-sm">{l.color || '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{l.rollCount != null ? l.rollCount : '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{l.qty != null ? `${l.qty}${l.unit || ''}` : '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{l.unit_price != null ? `¥${l.unit_price}` : '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums font-medium">¥{l.amountCny.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-green-700">{l.paidPortion > 0 ? `¥${l.paidPortion.toLocaleString()}` : '—'}</TableCell>
                      <TableCell className={`text-right text-sm tabular-nums ${l.unpaidPortion > 0.005 ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>{l.unpaidPortion > 0.005 ? `¥${l.unpaidPortion.toLocaleString()}` : '已付清'}</TableCell>
                    </TableRow>
                  ))}
                  {lines.length === 0 && <TableRow><TableCell colSpan={10} className="text-center py-10 text-muted-foreground">暂无费用明细</TableCell></TableRow>}
                  {lines.length > 0 && (
                    <TableRow className="bg-muted/50 font-semibold border-t-2">
                      <TableCell colSpan={7} className="text-right">合计</TableCell>
                      <TableCell className="text-right">¥{summary.totalCharge.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-green-700">¥{summary.paid.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-red-600">¥{summary.unpaid.toLocaleString()}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 付款记录 */}
        <TabsContent value="payments" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>付款日期</TableHead>
                    <TableHead className="text-right">金额(¥)</TableHead>
                    <TableHead>备注</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map(p => (
                    <TableRow key={p.id}>
                      <TableCell className="text-sm">{p.paid_at ? new Date(p.paid_at).toLocaleDateString('zh-CN') : '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-green-700">¥{(Number(p.amount) || 0).toLocaleString()}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{p.note || '—'}</TableCell>
                    </TableRow>
                  ))}
                  {payments.length === 0 && <TableRow><TableCell colSpan={3} className="text-center py-10 text-muted-foreground">暂无付款记录（可在「对账单」登记付款）</TableCell></TableRow>}
                  {payments.length > 0 && (
                    <TableRow className="bg-muted/50 font-semibold border-t-2">
                      <TableCell className="text-right">已付合计</TableCell>
                      <TableCell className="text-right text-green-700">¥{summary.paid.toLocaleString()}</TableCell>
                      <TableCell />
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* 未付明细 */}
        <TabsContent value="unpaid" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">未付明细（应付余额 ¥{summary.unpaid.toLocaleString()}）</CardTitle>
              <p className="text-xs text-muted-foreground">已登记付款按「先冲抵最早费用」抵扣后，下列为仍未付清的费用。</p>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">日期</TableHead>
                    <TableHead>内部订单号</TableHead>
                    <TableHead className="min-w-[120px]">品名</TableHead>
                    <TableHead>颜色</TableHead>
                    <TableHead className="text-right">匹数</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">单价</TableHead>
                    <TableHead className="text-right">金额(¥)</TableHead>
                    <TableHead className="text-right">已付款</TableHead>
                    <TableHead className="text-right">未付</TableHead>
                    <TableHead className="text-right">账龄</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {unpaidLines.map(l => (
                    <TableRow key={l.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(l.createdAt).toLocaleDateString('zh-CN')}</TableCell>
                      <TableCell className="text-sm font-medium">{l.orderLabel || '—'}</TableCell>
                      <TableCell className="text-sm">{l.description}</TableCell>
                      <TableCell className="text-sm">{l.color || '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{l.rollCount != null ? l.rollCount : '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{l.qty != null ? `${l.qty}${l.unit || ''}` : '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{l.unit_price != null ? `¥${l.unit_price}` : '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">¥{l.amountCny.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums text-green-700">{l.amountCny - l.unpaidPortion > 0.005 ? `¥${(Math.round((l.amountCny - l.unpaidPortion) * 100) / 100).toLocaleString()}` : '—'}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums font-semibold text-red-600">¥{l.unpaidPortion.toLocaleString()}</TableCell>
                      <TableCell className={`text-right text-xs ${l.agingDays > 60 ? 'text-red-600' : 'text-muted-foreground'}`}>{l.agingDays}天</TableCell>
                    </TableRow>
                  ))}
                  {unpaidLines.length === 0 && <TableRow><TableCell colSpan={11} className="text-center py-10 text-muted-foreground">已全部付清 🎉</TableCell></TableRow>}
                  {unpaidLines.length > 0 && (
                    <TableRow className="bg-red-50/50 font-semibold border-t-2">
                      <TableCell colSpan={9} className="text-right">应付余额合计</TableCell>
                      <TableCell className="text-right text-red-600">¥{summary.unpaid.toLocaleString()}</TableCell>
                      <TableCell />
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
