'use client'

// ============================================================
// 供应商应付明细 — 独立页面（替代列表内下拉展开）
//
// 顶部「对账三角」：产生总金额 − 已付金额 = 应付余额
// 三个视图（Tab）：
//   1) 按品名汇总：黑色总公斤/吊牌总件数 等，便于与供应商送货核对
//   2) 全部费用明细：费用类型/品名/关联订单/数量/单位/单价/金额/录入日/账龄
//   3) 付款记录：已登记付款流水
// ============================================================

import { use, useState, useEffect, useMemo, Fragment } from 'react'
import Link from 'next/link'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { ArrowLeft, Loader2, Package, ChevronRight, ChevronDown, Wallet } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { getSupplierPayments } from '@/lib/supabase/queries-v2'
import { normalizeSupplierName, escapeIlike } from '@/lib/utils'
import type { SupplierPayment } from '@/lib/types'

interface Line {
  id: string
  cost_type: string
  description: string
  orderLabel: string
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

export default function SupplierPayableDetailPage({ params }: { params: Promise<{ supplier: string }> }) {
  const { supplier: supplierParam } = use(params)
  const supplierName = decodeURIComponent(supplierParam)

  const [loading, setLoading] = useState(true)
  const [lines, setLines] = useState<Line[]>([])
  const [payments, setPayments] = useState<SupplierPayment[]>([])
  const [expandedItem, setExpandedItem] = useState<Record<string, boolean>>({})

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const supabase = createClient()
        // 用 ilike 缩小范围，再按归一化名严格筛选（兼容空格/全半角差异）
        const like = `%${escapeIlike(supplierName)}%`
        const [costRes, syncedRes, payList] = await Promise.all([
          supabase
            .from('cost_items')
            .select('id, cost_type, description, supplier, amount, currency, exchange_rate, quantity, unit, unit_price, source_id, budget_order_id, created_at, budget_orders(order_no)')
            .is('deleted_at', null)
            .ilike('supplier', like)
            .order('created_at', { ascending: true }),
          supabase.from('synced_orders').select('budget_order_id, order_no, style_no').not('budget_order_id', 'is', null),
          getSupplierPayments({ supplierName }),
        ])

        const syncMap = new Map<string, string>()
        ;(syncedRes.data || []).forEach((s: Record<string, unknown>) => {
          if (s.budget_order_id) {
            const internal = s.style_no ? `${s.style_no} | ` : ''
            syncMap.set(s.budget_order_id as string, `${internal}${(s.order_no as string) || ''}`)
          }
        })

        const ls: Line[] = (costRes.data || [])
          .filter((c: Record<string, unknown>) => normalizeSupplierName(c.supplier as string) === supplierName)
          .map((c: Record<string, unknown>) => {
            const boId = c.budget_order_id as string | null
            const bo = c.budget_orders as { order_no?: string } | null
            const orderLabel = boId ? (syncMap.get(boId) || bo?.order_no || '') : ''
            const rate = (c.currency as string) === 'CNY' ? 1 : (Number(c.exchange_rate) || 1)
            // 数量/单位/单价：优先真实列，缺失回退 source_id JSON
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
              qty, unit, unit_price: price,
              amountCny: r2((Number(c.amount) || 0) * rate),
              createdAt: c.created_at as string,
              agingDays: daysSince(c.created_at as string),
            }
          })
        setLines(ls)
        setPayments((payList || []).filter(p => normalizeSupplierName(p.supplier_name) === supplierName))
      } catch (e) {
        console.error('加载供应商应付明细失败:', e)
      }
      setLoading(false)
    }
    load()
  }, [supplierName])

  // 汇总数字
  const summary = useMemo(() => {
    const totalCharge = r2(lines.reduce((s, l) => s + l.amountCny, 0))
    const paid = r2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0))
    const unpaid = r2(totalCharge - paid)
    const orders = [...new Set(lines.map(l => l.orderLabel).filter(Boolean))]
    // FIFO：付款冲抵最早费用，找最早未结清费用的账龄
    let remaining = paid
    let oldestAging = 0
    for (const l of lines) {
      if (remaining >= l.amountCny) { remaining -= l.amountCny; continue }
      oldestAging = l.agingDays; break
    }
    return { totalCharge, paid, unpaid, count: lines.length, orderCount: orders.length, oldestAging }
  }, [lines, payments])

  // 按品名汇总（跨笔累加数量，便于核对送货）
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
      return { key, name: v.name, cost_type: v.cost_type, qtyLabel, amount: r2(v.amount), price: totalQty > 0 ? r2(v.amount / totalQty) : null, rows: v.rows }
    }).sort((a, b) => b.amount - a.amount)
  }, [lines])

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const isCleared = summary.unpaid <= 0.005

  return (
    <div className="flex flex-col h-full">
      <Header title="供应商应付明细" subtitle={supplierName} />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <Link href="/payables"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />返回应付账款</Button></Link>
          <Link href={`/reports/supplier?q=${encodeURIComponent(supplierName)}`}>
            <Button variant="outline" size="sm"><Wallet className="h-4 w-4 mr-1" />去登记付款 / 对账单</Button>
          </Link>
        </div>

        {/* 对账三角：产生总额 − 已付 = 应付 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">产生总金额（费用合计）</p>
              <p className="text-2xl font-bold mt-1">¥{summary.totalCharge.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{summary.count} 笔费用 · {summary.orderCount} 个关联订单</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">已付金额（已登记付款）</p>
              <p className="text-2xl font-bold mt-1 text-green-600">−¥{summary.paid.toLocaleString()}</p>
              <p className="text-[11px] text-muted-foreground mt-1">{payments.length} 笔付款</p>
            </CardContent>
          </Card>
          <Card className={isCleared ? 'border-green-200 bg-green-50/40' : 'border-red-200 bg-red-50/40'}>
            <CardContent className="p-5">
              <p className="text-xs text-muted-foreground">应付余额（实际未付）</p>
              <p className={`text-2xl font-bold mt-1 ${isCleared ? 'text-green-700' : 'text-red-600'}`}>
                {isCleared && summary.unpaid < -0.005 ? `多付 ¥${Math.abs(summary.unpaid).toLocaleString()}` : `¥${summary.unpaid.toLocaleString()}`}
              </p>
              <p className="text-[11px] mt-1">
                {isCleared ? <Badge className="bg-green-100 text-green-700">已结清</Badge>
                  : <span className={summary.oldestAging > 60 ? 'text-red-600 font-medium' : 'text-muted-foreground'}>最长账龄 {summary.oldestAging} 天</span>}
              </p>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="byitem">
          <TabsList>
            <TabsTrigger value="byitem">按品名汇总 ({byItem.length})</TabsTrigger>
            <TabsTrigger value="all">全部费用明细 ({lines.length})</TabsTrigger>
            <TabsTrigger value="payments">付款记录 ({payments.length})</TabsTrigger>
          </TabsList>

          {/* 按品名汇总 */}
          <TabsContent value="byitem" className="mt-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2"><Package className="h-4 w-4 text-primary" />按品名汇总（核对供应商送货）</CardTitle>
                <p className="text-xs text-muted-foreground">同一品名跨多笔/多单累加数量（如 黑色总公斤、吊牌总件数）；点开看每一笔。</p>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[180px]">品名</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead className="text-right">数量合计</TableHead>
                      <TableHead className="text-right">单价(约)</TableHead>
                      <TableHead className="text-right">金额(¥)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {byItem.map(it => {
                      const open = !!expandedItem[it.key]
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
                            <TableCell className="text-right font-medium">{it.qtyLabel}</TableCell>
                            <TableCell className="text-right text-muted-foreground">{it.price != null ? `¥${it.price}` : '—'}</TableCell>
                            <TableCell className="text-right font-medium">¥{it.amount.toLocaleString()}</TableCell>
                          </TableRow>
                          {open && it.rows.map(r => (
                            <TableRow key={r.id} className="bg-muted/20">
                              <TableCell className="pl-9 text-xs text-muted-foreground">{r.orderLabel || '—'}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleDateString('zh-CN')}</TableCell>
                              <TableCell className="text-right text-xs">{r.qty != null ? `${r.qty}${r.unit || ''}` : '—'}</TableCell>
                              <TableCell className="text-right text-xs text-muted-foreground">{r.unit_price != null ? `¥${r.unit_price}` : '—'}</TableCell>
                              <TableCell className="text-right text-xs">¥{r.amountCny.toLocaleString()}</TableCell>
                            </TableRow>
                          ))}
                        </Fragment>
                      )
                    })}
                    {byItem.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">暂无费用明细</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* 全部费用明细 */}
          <TabsContent value="all" className="mt-4">
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>类型</TableHead>
                      <TableHead className="min-w-[140px]">品名/描述</TableHead>
                      <TableHead>关联订单</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead>单位</TableHead>
                      <TableHead className="text-right">单价</TableHead>
                      <TableHead className="text-right">金额(¥)</TableHead>
                      <TableHead>录入日</TableHead>
                      <TableHead className="text-right">账龄</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map(l => (
                      <TableRow key={l.id}>
                        <TableCell><span className="text-xs text-muted-foreground">{COST_TYPE_LABEL[l.cost_type] || l.cost_type}</span></TableCell>
                        <TableCell className="text-sm">{l.description}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{l.orderLabel || '—'}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{l.qty != null ? l.qty : '—'}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{l.unit || '—'}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums">{l.unit_price != null ? `¥${l.unit_price}` : '—'}</TableCell>
                        <TableCell className="text-right text-sm tabular-nums font-medium">¥{l.amountCny.toLocaleString()}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{new Date(l.createdAt).toLocaleDateString('zh-CN')}</TableCell>
                        <TableCell className={`text-right text-xs ${l.agingDays > 60 ? 'text-red-600' : 'text-muted-foreground'}`}>{l.agingDays}天</TableCell>
                      </TableRow>
                    ))}
                    {lines.length === 0 && <TableRow><TableCell colSpan={9} className="text-center py-10 text-muted-foreground">暂无费用明细</TableCell></TableRow>}
                    {lines.length > 0 && (
                      <TableRow className="bg-muted/50 font-semibold border-t-2">
                        <TableCell colSpan={6} className="text-right">费用合计</TableCell>
                        <TableCell className="text-right">¥{summary.totalCharge.toLocaleString()}</TableCell>
                        <TableCell colSpan={2} />
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
        </Tabs>
      </div>
    </div>
  )
}
