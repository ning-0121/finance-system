'use client'

// ============================================================
// 订单费用预算总表 — 按订单看「预算 vs 已录入」执行情况 + 采购单交付
// 预算来源：budget_orders.items[0]._cost_breakdown（金额恒为 CNY）
// 实际来源：cost_items（按各自币种折 CNY），分类桶与 GL 成本结转同口径
// 采购单：fin_purchase_orders（订单系统 purchase_order.placed 入账；表未建时给提示）
// ============================================================

import { useState, useEffect, useMemo } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, Search, ChevronRight, ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

interface CostLike {
  budget_order_id: string | null
  cost_type: string
  amount: number
  currency: string
  exchange_rate: number
}

// 分类桶（与 GL 成本结转同口径）
const BUCKETS = ['面料', '辅料', '加工费', '货代', '装柜', '物流/其他'] as const
type Bucket = typeof BUCKETS[number]
const bucketOf = (t: string): Bucket => {
  switch (t) {
    case 'fabric': case 'procurement': return '面料'
    case 'accessory': return '辅料'
    case 'processing': case 'commission': return '加工费'
    case 'freight': return '货代'
    case 'container': case 'customs': return '装柜'
    default: return '物流/其他'
  }
}
// _cost_breakdown 键 → 桶
const BREAKDOWN_KEY: Record<string, Bucket> = {
  fabric: '面料', accessory: '辅料', processing: '加工费',
  forwarder: '货代', container: '装柜', logistics: '物流/其他',
}

interface OrderRow {
  id: string
  label: string          // 内部单号 | QM号 - 客户
  qty: number | null
  status: string
  budget: Record<Bucket, number>
  budgetTotal: number
  hasBreakdown: boolean
  actual: Record<Bucket, number>
  actualTotal: number
}

interface PoRow {
  po_no: string
  supplier_name: string | null
  total_amount: number | null
  currency: string
  status: string | null
  delivery_date: string | null
  placed_at: string | null
}

const money = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
const zeroBuckets = (): Record<Bucket, number> => ({ '面料': 0, '辅料': 0, '加工费': 0, '货代': 0, '装柜': 0, '物流/其他': 0 })

export function BudgetOverview({ costItems }: { costItems: CostLike[] }) {
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [posByOrder, setPosByOrder] = useState<Record<string, PoRow[]>>({})
  const [poTableMissing, setPoTableMissing] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [q, setQ] = useState('')

  useEffect(() => {
    let alive = true
    async function load() {
      const sb = createClient()
      const [{ data: bos }, { data: synced }] = await Promise.all([
        sb.from('budget_orders')
          .select('id, order_no, status, currency, exchange_rate, total_cost, items, customers(company)')
          .is('deleted_at', null).neq('status', 'rejected')
          .order('created_at', { ascending: false }),
        sb.from('synced_orders').select('budget_order_id, order_no, style_no, customer_name, quantity').not('budget_order_id', 'is', null),
      ])
      if (!alive) return

      const syncMap = new Map<string, { label: string; qty: number | null; qmNo: string }>()
      ;(synced || []).forEach(s => {
        const internal = s.style_no ? `${s.style_no} | ` : ''
        const customer = s.customer_name ? ` - ${s.customer_name}` : ''
        syncMap.set(s.budget_order_id as string, { label: `${internal}${s.order_no}${customer}`, qty: Number(s.quantity) || null, qmNo: s.order_no as string })
      })

      const rows: OrderRow[] = (bos || []).map(o => {
        const sync = syncMap.get(o.id as string)
        const cust = (o.customers as { company?: string } | null)?.company
        const label = sync?.label || `${o.order_no}${cust ? ` - ${cust}` : ''}`
        // 预算：_cost_breakdown（CNY）；无分解则回退 total_cost 仅作合计
        const cb = ((o.items as Record<string, unknown>[] | null)?.[0]?._cost_breakdown || null) as Record<string, unknown> | null
        const budget = zeroBuckets()
        let hasBreakdown = false
        if (cb) {
          for (const [k, bucket] of Object.entries(BREAKDOWN_KEY)) {
            const v = Number(cb[k]) || 0
            if (v > 0) { budget[bucket] += v; hasBreakdown = true }
          }
          for (const e of (cb.extras as { name?: string; amount?: number }[] | undefined) || []) {
            const v = Number(e?.amount) || 0
            if (v > 0) { budget['物流/其他'] += v; hasBreakdown = true }
          }
        }
        const budgetTotal = hasBreakdown
          ? Object.values(budget).reduce((s, v) => s + v, 0)
          : (Number(o.total_cost) || 0)
        return {
          id: o.id as string, label, qty: sync?.qty ?? null, status: (o.status as string) || '',
          budget, budgetTotal, hasBreakdown, actual: zeroBuckets(), actualTotal: 0,
        }
      })
      setOrders(rows)

      // 采购单（表可能未建：捕获错误给提示）
      const { data: pos, error: poErr } = await sb.from('fin_purchase_orders')
        .select('po_no, supplier_name, total_amount, currency, status, delivery_date, placed_at, order_refs')
        .is('deleted_at', null)
      if (!alive) return
      if (poErr) {
        setPoTableMissing(true)
      } else {
        // order_refs(jsonb 数组)按 QM 单号/synced id 匹配到 budget_order
        const byOrder: Record<string, PoRow[]> = {}
        const qmToBoId = new Map<string, string>()
        syncMap.forEach((v, boId) => qmToBoId.set(v.qmNo, boId))
        for (const p of pos || []) {
          const refs = JSON.stringify(p.order_refs || [])
          qmToBoId.forEach((boId, qmNo) => {
            if (qmNo && refs.includes(qmNo)) {
              (byOrder[boId] ||= []).push(p as unknown as PoRow)
            }
          })
        }
        setPosByOrder(byOrder)
      }
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [])

  // 实际：按订单×桶聚合（折 CNY）
  const actualByOrder = useMemo(() => {
    const m = new Map<string, { buckets: Record<Bucket, number>; total: number }>()
    for (const c of costItems) {
      if (!c.budget_order_id) continue
      if (c.cost_type === 'tax_point') continue   // 票点不计预算执行(留作退税核算)
      const rate = (c.currency || 'CNY') === 'CNY' ? 1 : (Number(c.exchange_rate) || 1)
      const cny = (Number(c.amount) || 0) * rate
      const e = m.get(c.budget_order_id) || { buckets: zeroBuckets(), total: 0 }
      e.buckets[bucketOf(c.cost_type)] += cny
      e.total += cny
      m.set(c.budget_order_id, e)
    }
    return m
  }, [costItems])

  const enriched = useMemo(() => {
    const rows = orders.map(o => {
      const a = actualByOrder.get(o.id)
      return { ...o, actual: a?.buckets || zeroBuckets(), actualTotal: a?.total || 0 }
    })
    const qq = q.trim().toLowerCase()
    const filtered = qq ? rows.filter(r => r.label.toLowerCase().includes(qq)) : rows
    // 排序：超支最前，其次执行率高的
    return filtered.sort((x, y) => {
      const ox = x.budgetTotal > 0 && x.actualTotal > x.budgetTotal ? 1 : 0
      const oy = y.budgetTotal > 0 && y.actualTotal > y.budgetTotal ? 1 : 0
      if (ox !== oy) return oy - ox
      return y.actualTotal - x.actualTotal
    })
  }, [orders, actualByOrder, q])

  const statusOf = (r: OrderRow & { actualTotal: number }) => {
    if (r.budgetTotal <= 0) return { label: '预算未填', cls: 'bg-gray-100 text-gray-600' }
    const pct = r.actualTotal / r.budgetTotal
    if (pct > 1.0001) return { label: `超支 ${Math.round((pct - 1) * 100)}%`, cls: 'bg-red-100 text-red-700' }
    if (pct >= 0.9) return { label: `接近预算 ${Math.round(pct * 100)}%`, cls: 'bg-amber-100 text-amber-700' }
    return { label: `执行 ${Math.round(pct * 100)}%`, cls: 'bg-green-100 text-green-700' }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="搜内部单号/客户..." className="pl-8 h-8 w-[240px] text-sm" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        {poTableMissing && (
          <p className="text-xs text-amber-600">采购单登记簿(fin_purchase_orders)尚未建表——执行对接 SQL 后，订单系统下的采购单会自动出现在此处。</p>
        )}
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30px]"></TableHead>
                <TableHead>订单</TableHead>
                <TableHead className="text-right">数量</TableHead>
                <TableHead className="text-right">预算成本(¥)</TableHead>
                <TableHead className="text-right">已录入(¥)</TableHead>
                <TableHead className="text-right">差额(¥)</TableHead>
                <TableHead>执行状态</TableHead>
                <TableHead className="text-center">采购单</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {enriched.length === 0 && <TableRow><TableCell colSpan={8} className="text-center py-14 text-muted-foreground">无匹配订单</TableCell></TableRow>}
              {enriched.map(r => {
                const st = statusOf(r)
                const diff = r.budgetTotal - r.actualTotal
                const pos = posByOrder[r.id] || []
                const open = !!expanded[r.id]
                return (
                  <>
                    <TableRow key={r.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setExpanded(p => ({ ...p, [r.id]: !p[r.id] }))}>
                      <TableCell>{open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}</TableCell>
                      <TableCell className="text-sm font-medium">{r.label}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">{r.qty != null ? r.qty.toLocaleString() : '-'}</TableCell>
                      <TableCell className="text-right text-sm">{r.budgetTotal > 0 ? money(r.budgetTotal) : <span className="text-muted-foreground">未填</span>}</TableCell>
                      <TableCell className="text-right text-sm font-semibold">{money(r.actualTotal)}</TableCell>
                      <TableCell className={`text-right text-sm font-medium ${diff < 0 ? 'text-red-600' : 'text-muted-foreground'}`}>{r.budgetTotal > 0 ? money(diff) : '-'}</TableCell>
                      <TableCell><Badge className={`${st.cls} border-0 text-[11px]`}>{st.label}</Badge></TableCell>
                      <TableCell className="text-center text-sm">{poTableMissing ? '—' : (pos.length || '-')}</TableCell>
                    </TableRow>
                    {open && (
                      <TableRow key={`${r.id}-detail`} className="bg-muted/20 hover:bg-muted/20">
                        <TableCell></TableCell>
                        <TableCell colSpan={7} className="py-3">
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            {/* 分类执行 */}
                            <div>
                              <p className="text-xs font-medium mb-1.5">分类执行（预算 → 已录入）</p>
                              <div className="space-y-1">
                                {BUCKETS.map(b => {
                                  const bud = r.budget[b], act = r.actual[b]
                                  if (bud <= 0 && act <= 0) return null
                                  const over = bud > 0 && act > bud * 1.0001
                                  return (
                                    <div key={b} className="flex items-center justify-between text-xs">
                                      <span className="w-[72px] text-muted-foreground">{b}</span>
                                      <span className="tabular-nums">{r.hasBreakdown ? `¥${money(bud)}` : '—'} → <b className={over ? 'text-red-600' : ''}>¥{money(act)}</b>{over && <span className="text-red-600 ml-1">超</span>}</span>
                                    </div>
                                  )
                                })}
                                {!r.hasBreakdown && <p className="text-[11px] text-muted-foreground">该订单预算未做分类分解（编辑预算单可补），仅按合计对比。</p>}
                              </div>
                            </div>
                            {/* 采购单 */}
                            <div>
                              <p className="text-xs font-medium mb-1.5">采购单（{poTableMissing ? '待建表' : pos.length}）</p>
                              {poTableMissing ? (
                                <p className="text-[11px] text-amber-600">对接 SQL 执行后自动出现。</p>
                              ) : pos.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground">暂无采购单（订单系统下单后经 purchase_order.placed 自动登记）。</p>
                              ) : (
                                <div className="space-y-1">
                                  {pos.map(p => (
                                    <div key={p.po_no} className="flex items-center justify-between text-xs">
                                      <span className="truncate">{p.po_no} · {p.supplier_name || '—'}</span>
                                      <span className="tabular-nums shrink-0 ml-2">{p.currency} {Number(p.total_amount || 0).toLocaleString()} · {p.status || '-'}{p.delivery_date ? ` · 交期${String(p.delivery_date).slice(5)}` : ''}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-[11px] text-muted-foreground">口径：预算=预算单成本分解(¥)；已录入=费用归集折人民币，分类桶与 GL 成本结转一致；超支=已录入&gt;预算。采购单行级「已录入/已交付」状态待订单系统 V1.1 行数据(line_id)接入后点亮。</p>
    </div>
  )
}
