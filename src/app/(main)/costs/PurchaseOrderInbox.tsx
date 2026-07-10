'use client'

// 本页 useEffect(() => { load() }, [load]) 为挂载后拉数据的合法用法;React 编译器 react-hooks/set-state-in-effect
// 规则对此过严,本仓不以 lint 作提交闸(仅 build)→ 文件级豁免该规则一条(与既有 exhaustive-deps 内联豁免同源)。
/* eslint-disable react-hooks/set-state-in-effect */

// ============================================================
// 采购单工作台 —— 订单系统 purchase_order.placed 推来的采购单，财务在此
// 收到(系统内、非企微)、核对预算、一键登记为费用或忽略。
// 展开某采购单 → 按(关联订单+供应商)精确匹配预算明细行，展示预算 数量/单价/金额，
// 并与采购单金额比出「超/欠预算」，供审批决策(数据源:预算单 _cost_breakdown.lines)。
// ============================================================

import { useState, useEffect, useCallback, Fragment } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { normalizeOrderRefs } from '@/lib/integration/order-refs'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, PackageCheck, ChevronRight, ChevronDown, Ban, Inbox } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

export interface PoForRegister {
  id: string
  po_no: string
  supplier_name: string | null
  total_amount: number | null
  currency: string
  budget_order_id: string | null   // 由 order_refs 解析到的本系统订单
}

interface PoReceipt { ordered: number; received: number; anyReceived: boolean; receivedAmount: number }
interface PoRow extends PoForRegister {
  delivery_date: string | null
  status: string | null
  placed_at: string | null
  order_refs: unknown
  fin_status: string
  orderLabel: string
  rcv: PoReceipt | null   // 收货实收 vs 订购(止血:提示按实收付款)
}

// 预算明细行（来自 budget_orders.items[0]._cost_breakdown.lines[bucket]）
interface BLine { bucket: string; name: string; supplier?: string; qty?: number; unit?: string; unit_price?: number; amount?: number }

const money = (n: number | null | undefined) => (n == null ? '-' : Number(n).toLocaleString())
const r2 = (n: number) => Math.round(n * 100) / 100
const norm = (x?: string | null) => (x || '').replace(/[（(].*?[)）]|\s/g, '').toLowerCase()
// 供应商名匹配：规范化后【等值】(审计P2:双向子串会把「恒生」误配「恒生源辅料」「大恒生物」→ 预算对照失真)
const supMatch = (a?: string | null, b?: string | null) => {
  const na = norm(a), nb = norm(b)
  return !!na && !!nb && na === nb
}
// 收货实收 vs 订购的付款提示(止血):有到货且短装→红(建议按实收付款);超收→黄;齐→绿;未到货→不提示
function receiptWarn(rcv: PoReceipt | null, currency: string): { tone: 'red' | 'amber' | 'green'; text: string } | null {
  if (!rcv || !rcv.anyReceived || rcv.ordered <= 0) return null
  if (rcv.received < rcv.ordered * 0.999) return { tone: 'red', text: `⚠ 实收 ${r2(rcv.received)}/${r2(rcv.ordered)} 短装 · 建议按实收 ${currency} ${money(r2(rcv.receivedAmount))} 付款` }
  if (rcv.received > rcv.ordered * 1.001) return { tone: 'amber', text: `超收 ${r2(rcv.received)}/${r2(rcv.ordered)} · 核对后付款` }
  return { tone: 'green', text: `实收=订购 ${r2(rcv.received)}` }
}
const WARN_CLS: Record<'red' | 'amber' | 'green', string> = {
  red: 'text-red-600', amber: 'text-amber-600', green: 'text-emerald-600',
}

export function PurchaseOrderInbox({ syncedOrderMap, onRegister, onChanged }: {
  syncedOrderMap: Record<string, string>
  onRegister: (po: PoForRegister) => void
  onChanged?: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<PoRow[]>([])
  const [tab, setTab] = useState<'pending' | 'all'>('pending')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [budgetCache, setBudgetCache] = useState<Record<string, BLine[]>>({})
  const [budgetLoading, setBudgetLoading] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const sb = createClient()
    const { data, error } = await sb.from('fin_purchase_orders')
      .select('id, po_no, supplier_name, total_amount, currency, delivery_date, status, placed_at, order_refs, fin_status')
      .is('deleted_at', null).order('placed_at', { ascending: false, nullsFirst: false }).limit(500)
    if (error) { console.error('[采购单] 加载失败:', error.message); setLoading(false); return }
    // order_refs(QM单号数组) → 本系统 budget_order_id：精确匹配 syncedOrderMap 的反查
    const qmToBoId = new Map<string, string>()
    for (const [boId, label] of Object.entries(syncedOrderMap)) {
      const qm = label.split(' - ')[0].split(' | ').pop()?.trim()  // label 形如 "款号 | QM号 - 客户"
      if (qm) qmToBoId.set(qm, boId)
    }
    const baseRows: PoRow[] = (data || []).map(p => {
      const nrefs = normalizeOrderRefs(p.order_refs)
      let boId: string | null = null
      for (const r of nrefs) { const hit = qmToBoId.get(String(r.order_no || r.id).trim()); if (hit) { boId = hit; break } }
      return {
        id: p.id as string, po_no: p.po_no as string, supplier_name: (p.supplier_name as string) || null,
        total_amount: p.total_amount as number | null, currency: (p.currency as string) || 'CNY',
        delivery_date: (p.delivery_date as string) || null, status: (p.status as string) || null,
        placed_at: (p.placed_at as string) || null, order_refs: p.order_refs,
        budget_order_id: boId, fin_status: (p.fin_status as string) || 'pending',
        orderLabel: boId ? (syncedOrderMap[boId] || '') : (nrefs.map(r => r.internal_order_no || r.order_no || r.id).join(', ') || ''),
        rcv: null,
      }
    })
    // 止血(审计 #3):拉每张单的收货实收 vs 订购,提示财务按实收付款、别盲按下单额(收货实收永不回冲应付前的可见性兜底)
    const rcvByPo = new Map<string, PoReceipt>()
    const poIds = baseRows.map(r => r.id)
    if (poIds.length) {
      const { data: lns } = await sb.from('fin_po_lines').select('fin_po_id, ordered_qty, received_qty, unit_price').in('fin_po_id', poIds)
      for (const l of (lns || [])) {
        const k = l.fin_po_id as string
        const g = rcvByPo.get(k) || { ordered: 0, received: 0, anyReceived: false, receivedAmount: 0 }
        g.ordered += Number(l.ordered_qty) || 0
        if (l.received_qty != null) { g.anyReceived = true; g.received += Number(l.received_qty) || 0; g.receivedAmount += (Number(l.received_qty) || 0) * (Number(l.unit_price) || 0) }
        rcvByPo.set(k, g)
      }
    }
    setRows(baseRows.map(r => ({ ...r, rcv: rcvByPo.get(r.id) || null })))
    setLoading(false)
  }, [syncedOrderMap])

  useEffect(() => { load() }, [load])

  // 展开时懒加载该订单的预算明细行（缓存）
  const loadBudget = useCallback(async (boId: string) => {
    if (budgetCache[boId]) return
    setBudgetLoading(boId)
    const sb = createClient()
    const { data } = await sb.from('budget_orders').select('items').eq('id', boId).maybeSingle()
    const cb = (data?.items as Record<string, unknown>[] | null)?.[0]?._cost_breakdown as Record<string, unknown> | undefined
    const lines = (cb?.lines as Record<string, BLine[]> | undefined) || {}
    const flat: BLine[] = []
    for (const [bucket, arr] of Object.entries(lines)) for (const l of (arr || [])) flat.push({ ...l, bucket })
    setBudgetCache(prev => ({ ...prev, [boId]: flat }))
    setBudgetLoading(null)
  }, [budgetCache])

  const toggleExpand = (p: PoRow) => {
    if (expandedId === p.id) { setExpandedId(null); return }
    setExpandedId(p.id)
    if (p.budget_order_id) loadBudget(p.budget_order_id)
  }

  const setStatus = async (id: string, fin_status: 'ignored' | 'pending') => {
    const sb = createClient()
    const { data: u } = await sb.auth.getUser()
    const { data, error } = await sb.from('fin_purchase_orders')
      .update({ fin_status, processed_at: new Date().toISOString(), processed_by: u?.user?.id || null })
      .eq('id', id).select('id')
    if (error) { toast.error(`操作失败：${error.message}`); return }
    if (!data || data.length === 0) { toast.error('无权限或记录不存在'); return }
    toast.success(fin_status === 'ignored' ? '已忽略' : '已恢复待处理')
    load(); onChanged?.()
  }

  // 审计#9:approved(≥¥5000已审批放行)与 pending 一样应可登记为费用 —— 否则批准后进不了付款链。
  //   pending_approval(待审批)不在此处理(去「采购审批」页);registered/ignored/rejected 也不在待办。
  const isActionable = (s: string) => s === 'pending' || s === 'approved'
  const shown = rows.filter(r => tab === 'all' ? true : isActionable(r.fin_status))
  const pendingCount = rows.filter(r => isActionable(r.fin_status)).length

  // 渲染某采购单的预算对比（按供应商匹配到的预算明细行）
  const renderBudgetCompare = (p: PoRow) => {
    if (!p.budget_order_id) return <p className="text-sm text-amber-600 py-2">采购单未关联到本系统订单（order_refs 未命中），无法比对预算。</p>
    if (budgetLoading === p.budget_order_id || budgetCache[p.budget_order_id] === undefined)
      return <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载预算明细…</div>
    const flat = budgetCache[p.budget_order_id] || []
    const matched = flat.filter(l => supMatch(l.supplier, p.supplier_name))
    const budgetTotal = r2(matched.reduce((s, l) => s + (l.amount || 0), 0))
    const poTotal = Number(p.total_amount) || 0
    const over = poTotal > 0 && budgetTotal > 0 && poTotal > budgetTotal
    return (
      <div className="py-2 space-y-2">
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium">预算对比</span>
          <span className="text-muted-foreground">供应商「{p.supplier_name || '—'}」在本订单预算里匹配到 {matched.length} 行</span>
        </div>
        {matched.length === 0 ? (
          <p className="text-sm text-muted-foreground">该供应商在本订单预算明细里无对应行（可能预算未按此供应商分解，或供应商名不一致）。</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead className="text-xs">预算品名/摘要</TableHead>
                <TableHead className="text-xs text-right">预算数量</TableHead>
                <TableHead className="text-xs text-right">预算单价</TableHead>
                <TableHead className="text-xs text-right">预算金额(¥)</TableHead>
                <TableHead className="text-xs">类目</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {matched.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{l.name}</TableCell>
                    <TableCell className="text-sm text-right tabular-nums">{l.qty != null ? `${l.qty}${l.unit || ''}` : '-'}</TableCell>
                    <TableCell className="text-sm text-right tabular-nums">{l.unit_price != null ? money(l.unit_price) : '-'}</TableCell>
                    <TableCell className="text-sm text-right tabular-nums">{money(l.amount)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.bucket}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {/* 采购单 vs 预算 总额比对 */}
        <div className="flex flex-wrap items-center gap-4 text-sm pt-1">
          <span>预算合计(该供应商)：<b className="tabular-nums">¥{money(budgetTotal)}</b></span>
          <span>采购单金额：<b className="tabular-nums">{p.currency} {money(p.total_amount)}</b></span>
          {budgetTotal > 0 && poTotal > 0 && (
            over
              ? <Badge className="bg-red-100 text-red-700 border-0">超预算 ¥{money(r2(poTotal - budgetTotal))}（{Math.round((poTotal / budgetTotal) * 100)}%）</Badge>
              : <Badge className="bg-green-100 text-green-700 border-0">在预算内（{Math.round((poTotal / budgetTotal) * 100)}%）</Badge>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant={tab === 'pending' ? 'default' : 'outline'} onClick={() => setTab('pending')}>待处理 ({pendingCount})</Button>
        <Button size="sm" variant={tab === 'all' ? 'default' : 'outline'} onClick={() => setTab('all')}>全部 ({rows.length})</Button>
        <span className="text-xs text-muted-foreground ml-2">点采购单行可展开「预算对比」；登记为费用即计入成本归集</span>
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : shown.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Inbox className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>{tab === 'pending' ? '暂无待处理采购单' : '暂无采购单'}</p>
              <p className="text-xs mt-1">采购单由订单系统在下单时推送（purchase_order.placed）。若长期为空，可能订单系统尚未开始推送采购数据。</p>
            </div>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead className="w-8"></TableHead>
                <TableHead>采购单号</TableHead>
                <TableHead>供应商</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>关联订单</TableHead>
                <TableHead>交期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-center">操作</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {shown.map(p => (
                  <Fragment key={p.id}>
                    <TableRow className={`${p.fin_status === 'pending' ? 'bg-amber-50/40' : ''} cursor-pointer`} onClick={() => toggleExpand(p)}>
                      <TableCell className="text-muted-foreground">{expandedId === p.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                      <TableCell className="font-medium text-sm">{p.po_no}</TableCell>
                      <TableCell className="text-sm">{p.supplier_name || <span className="text-amber-600">未带供应商名</span>}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        <div>{p.currency} {money(p.total_amount)}</div>
                        {(() => { const w = receiptWarn(p.rcv, p.currency); return w ? <div className={`text-[10px] font-medium ${WARN_CLS[w.tone]}`}>{w.text}</div> : null })()}
                      </TableCell>
                      <TableCell className="text-sm text-primary">{p.orderLabel || <span className="text-muted-foreground">未关联</span>}</TableCell>
                      <TableCell className="text-sm">{p.delivery_date ? String(p.delivery_date).slice(0, 10) : '-'}</TableCell>
                      <TableCell>
                        {p.fin_status === 'pending' && <Badge className="bg-amber-100 text-amber-700 border-0 text-[10px]">待处理</Badge>}
                        {p.fin_status === 'approved' && <Badge className="bg-purple-100 text-purple-700 border-0 text-[10px]">已批准·待登记</Badge>}
                        {p.fin_status === 'pending_approval' && <Badge className="bg-blue-100 text-blue-700 border-0 text-[10px]">待财务审批</Badge>}
                        {p.fin_status === 'rejected' && <Badge className="bg-red-100 text-red-700 border-0 text-[10px]">已驳回</Badge>}
                        {p.fin_status === 'registered' && <Badge className="bg-green-100 text-green-700 border-0 text-[10px]">已登记费用</Badge>}
                        {p.fin_status === 'ignored' && <Badge variant="outline" className="text-[10px]">已忽略</Badge>}
                      </TableCell>
                      <TableCell className="text-center" onClick={e => e.stopPropagation()}>
                        {isActionable(p.fin_status) ? (
                          <div className="flex items-center justify-center gap-1">
                            <Button size="sm" className="h-7 text-xs" onClick={() => onRegister(p)}><PackageCheck className="h-3.5 w-3.5 mr-1" />登记为费用<ChevronRight className="h-3 w-3" /></Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-muted-foreground" onClick={() => setStatus(p.id, 'ignored')}><Ban className="h-3.5 w-3.5" /></Button>
                          </div>
                        ) : p.fin_status === 'pending_approval' ? (
                          <a href="/purchase-approvals" className="text-xs text-blue-600 hover:underline">去审批 →</a>
                        ) : p.fin_status === 'ignored' ? (
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setStatus(p.id, 'pending')}>恢复</Button>
                        ) : <span className="text-xs text-green-600">✓</span>}
                      </TableCell>
                    </TableRow>
                    {expandedId === p.id && (
                      <TableRow className="bg-muted/20">
                        <TableCell colSpan={8} className="px-4">{renderBudgetCompare(p)}</TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
