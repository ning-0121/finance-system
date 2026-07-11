'use client'

// 本页多处用 reset-on-change 的 setState-in-effect(选中项变化时清空明细/预算),此为合法用法;
// React 编译器的 react-hooks/set-state-in-effect 规则对此过严(报告锚点在组件/effect 级,行内豁免不稳),
// 且本仓不以 lint 作提交闸(仅 build),故文件级豁免该规则一条(与本文件既有 exhaustive-deps 内联豁免同源)。
/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect, useCallback, Fragment, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, ShieldCheck, Ban, ChevronRight, ChevronDown, History, PackageCheck, Inbox, Paperclip, Sparkles, FileText, Plus, Trash2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import {
  getPendingPurchaseApprovals, getPoLines, getMaterialPriceHistory, decidePurchaseApproval,
  getPoAttachments, extractQuote, createBudgetFromQuote, BUCKET_LABELS,
  type PendingPO, type PoLine, type PriceHistoryRow, type PoAttachment, type QuoteResultUI, type QuoteCostLineUI,
} from '@/lib/supabase/purchase-approvals'
import { normalizeOrderRefs } from '@/lib/integration/order-refs'
import { openAttachment } from '@/lib/supabase/storage'

interface BLine { bucket: string; name: string; supplier?: string; qty?: number; unit?: string; unit_price?: number; amount?: number }
// PO 关联的节拍器订单(预算闸门 + 生成预算草稿的目标)
interface LinkedOrder { id: string; qm: string | null; internal: string | null; budget_order_id: string | null; total_amount: number | null; currency: string | null; quantity: number | null; quantity_unit: string | null }
// 预算草稿编辑行(字符串态便于输入)
interface DraftLine { bucket: string; name: string; supplier: string; qty: string; unit: string; unit_price: string; amount: string }
const money = (n: number | null | undefined) => (n == null ? '-' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 }))
const r2 = (n: number) => Math.round(n * 100) / 100
const fmtDate = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : '-')
const norm = (x?: string | null) => (x || '').replace(/[（(].*?[)）]|\s/g, '').toLowerCase()
// 审计P2:供应商对照用规范化后【等值】,不再双向子串——否则「恒生」会吸附「恒生源辅料」「大恒生物」
// 等无关预算行,budgetTotal 虚高/虚低致超预算误判。
const supMatch = (a?: string | null, b?: string | null) => {
  const na = norm(a), nb = norm(b)
  return !!na && !!nb && na === nb
}

export default function PurchaseApprovalsPage() {
  const [pos, setPos] = useState<PendingPO[]>([])
  const [loading, setLoading] = useState(true)
  const [selId, setSelId] = useState<string | null>(null)
  const [lines, setLines] = useState<PoLine[]>([])
  const [linesLoading, setLinesLoading] = useState(false)
  const [budget, setBudget] = useState<BLine[] | null>(null)
  const [budgetLoading, setBudgetLoading] = useState(false)
  const [expandedMat, setExpandedMat] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, PriceHistoryRow[] | 'loading'>>({})
  const [decideDlg, setDecideDlg] = useState<'approved' | 'rejected' | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})  // #2 按内部单号分组的折叠态(默认展开)

  // 附件 + 报价单识别(PO审批预算链 2026-07-11)
  const [atts, setAtts] = useState<PoAttachment[]>([])
  const [attsLoading, setAttsLoading] = useState(false)
  const [quotes, setQuotes] = useState<Record<string, QuoteResultUI | 'loading'>>({})   // docId → 识别结果
  const [qStyleIdx, setQStyleIdx] = useState(0)   // 多款核算单:当前查看/预填的款
  const [linkedOrders, setLinkedOrders] = useState<LinkedOrder[]>([])
  // 生成预算草稿弹窗
  const [bdOpen, setBdOpen] = useState(false)
  const [bdTarget, setBdTarget] = useState('')          // synced_order id
  const [bdRevenue, setBdRevenue] = useState('')
  const [bdCurrency, setBdCurrency] = useState('USD')
  const [bdRate, setBdRate] = useState('')
  const [bdQty, setBdQty] = useState('')
  const [bdLines, setBdLines] = useState<DraftLine[]>([])
  const [bdSourceDoc, setBdSourceDoc] = useState<string | null>(null)
  const [bdSaving, setBdSaving] = useState(false)

  const sel = pos.find(p => p.id === selId) || null

  const loadPending = useCallback(async () => {
    setLoading(true)
    const list = await getPendingPurchaseApprovals()
    setPos(list)
    setSelId(prev => prev && list.some(p => p.id === prev) ? prev : (list[0]?.id || null))
    setLoading(false)
  }, [])

  useEffect(() => { loadPending() }, [loadPending])

  // order_refs(QM号) → synced_orders.budget_order_id → budget_orders._cost_breakdown.lines
  // 注:声明必须在下方 useEffect 之前 —— 否则 useEffect 闭包在声明前引用它(TDZ),react-hooks/immutability 报错。
  const loadBudgetLines = async (po: PendingPO): Promise<{ lines: BLine[]; orders: LinkedOrder[] }> => {
    try {
      const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
      const ids = normalizeOrderRefs(po.order_refs).map(r => r.id).filter(isUuid)  // 非UUID(历史QM单号ref)会让 .in('id') 400
      if (ids.length === 0) return { lines: [], orders: [] }
      const sb = createClient()
      // order_refs 元素 = synced_orders.id(UUID);全量取回(含未建预算的 —— 预算闸门 + 生成草稿的目标)
      const { data: synced } = await sb.from('synced_orders')
        .select('id, order_no, style_no, budget_order_id, total_amount, currency, quantity, quantity_unit')
        .in('id', ids)
      const orders: LinkedOrder[] = ((synced as Record<string, unknown>[] | null) || []).map(s => ({
        id: String(s.id), qm: (s.order_no as string) || null, internal: (s.style_no as string) || null,
        budget_order_id: (s.budget_order_id as string) || null,
        total_amount: s.total_amount != null ? Number(s.total_amount) : null,
        currency: (s.currency as string) || null,
        quantity: s.quantity != null ? Number(s.quantity) : null,
        quantity_unit: (s.quantity_unit as string) || null,
      }))
      const boIds = [...new Set(orders.map(o => o.budget_order_id).filter(Boolean))] as string[]
      if (boIds.length === 0) return { lines: [], orders }
      const { data: bos } = await sb.from('budget_orders').select('items').in('id', boIds)
      const flat: BLine[] = []
      for (const bo of bos || []) {
        const cb = ((bo.items as Record<string, unknown>[] | null)?.[0]?._cost_breakdown) as Record<string, unknown> | undefined
        const ls = (cb?.lines as Record<string, BLine[]> | undefined) || {}
        for (const [bucket, arr] of Object.entries(ls)) for (const l of (arr || [])) flat.push({ ...l, bucket })
      }
      return { lines: flat, orders }
    } catch { return { lines: [], orders: [] } }
  }

  // 选中某采购单 → 载明细行 + 预算对照 + 附件
  useEffect(() => {
    if (!sel) { setLines([]); setBudget(null); setAtts([]); setLinkedOrders([]); return }
    setExpandedMat(null); setHistory({}); setQuotes({}); setQStyleIdx(0)
    ;(async () => {
      setLinesLoading(true)
      setLines(await getPoLines(sel.id))
      setLinesLoading(false)
    })()
    ;(async () => {
      setBudgetLoading(true)
      const { lines: bl, orders } = await loadBudgetLines(sel)
      setBudget(bl); setLinkedOrders(orders)
      setBudgetLoading(false)
    })()
    ;(async () => {
      setAttsLoading(true)
      const list = await getPoAttachments(sel.purchase_order_id)
      setAtts(list)
      // 已识别过的报价单直接带出缓存结果(extracted_fields._quote)
      const cached: Record<string, QuoteResultUI> = {}
      for (const a of list) {
        const q = (a.extracted_fields as Record<string, unknown> | null)?._quote as QuoteResultUI | undefined
        if (q?.success) cached[a.id] = q
      }
      if (Object.keys(cached).length) setQuotes(cached)
      setAttsLoading(false)
    })()
  }, [selId]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMat = async (l: PoLine) => {
    if (expandedMat === l.id) { setExpandedMat(null); return }
    setExpandedMat(l.id)
    if (!history[l.id]) {
      setHistory(h => ({ ...h, [l.id]: 'loading' }))
      const rows = await getMaterialPriceHistory({ material_code: l.material_code, material_name: l.material_name }, sel?.id)
      setHistory(h => ({ ...h, [l.id]: rows }))
    }
  }

  const doDecide = async () => {
    if (!sel || !decideDlg) return
    setBusy(true)
    const res = await decidePurchaseApproval(sel.purchase_order_id, decideDlg, note.trim() || undefined)
    setBusy(false)
    if (!res.ok) return toast.error(res.error || '操作失败')
    if (res.callback === 'failed') {
      toast.warning(`已${decideDlg === 'approved' ? '批准' : '驳回'},但回传节拍器失败(${res.callback_error || '网络'})——节拍器暂未收到,稍后可重推`)
    } else {
      toast.success(`已${decideDlg === 'approved' ? '批准放行' : '驳回'},已通知节拍器`)
    }
    setDecideDlg(null); setNote('')
    await loadPending()
  }

  // ── 报价单识别(按需调 AI;只读建议) ──
  const doExtract = async (att: PoAttachment, force = false) => {
    setQuotes(q => ({ ...q, [att.id]: 'loading' }))
    const res = await extractQuote(att.id, force)
    if (!res.ok || !res.quote) {
      setQuotes(q => { const n = { ...q }; delete n[att.id]; return n })
      toast.error(`识别失败：${res.error || '未知'}`)
      return
    }
    setQuotes(q => ({ ...q, [att.id]: res.quote! }))
    toast.success('报价单已识别，可「生成预算草稿」调价确认')
  }

  // ── 生成预算草稿(识别结果预填 → 财务调价 → 落库) ──
  const missingBudget = useMemo(() => linkedOrders.filter(o => !o.budget_order_id), [linkedOrders])
  const quoteReady = useMemo(() => {
    const entry = Object.entries(quotes).find(([, v]) => v !== 'loading' && (v as QuoteResultUI).success)
    return entry ? { docId: entry[0], quote: entry[1] as QuoteResultUI } : null
  }, [quotes])

  const lineAmount = (l: DraftLine) => {
    const q = Number(l.qty), p = Number(l.unit_price)
    if (l.qty && l.unit_price && !Number.isNaN(q) && !Number.isNaN(p)) return r2(q * p)
    return r2(Number(l.amount) || 0)
  }
  const bdCostTotal = useMemo(() => r2(bdLines.reduce((s, l) => s + lineAmount(l), 0)), [bdLines])
  const bdProfit = useMemo(() => {
    const rev = Number(bdRevenue), rate = bdCurrency === 'CNY' ? 1 : Number(bdRate)
    if (!rev || !rate || Number.isNaN(rev) || Number.isNaN(rate)) return null
    const p = r2(rev * rate - bdCostTotal)
    return { profit: p, margin: r2((p / (rev * rate)) * 100) }
  }, [bdRevenue, bdRate, bdCurrency, bdCostTotal])

  const openBudgetDraft = () => {
    if (missingBudget.length === 0) return
    const target = missingBudget[0]
    const q = quoteReady?.quote
    const style = q?.styles?.[qStyleIdx] || q?.styles?.[0]
    const qLines = style?.cost_lines || q?.cost_lines || []
    const orderQty = q?.quantity ?? target.quantity ?? null
    setBdTarget(target.id)
    setBdSourceDoc(quoteReady?.docId || null)
    setBdQty(orderQty != null ? String(orderQty) : '')
    if (q?.per_unit) {
      // 单件成本口径:每行 单价=单件金额、数量=订单件数 → 金额自动=件数×单件
      // 售价:优先订单同步总额(原币);没有则 单件含税价(CNY)×件数
      const sell = style?.sell_price ?? q.sell_price
      if (target.total_amount) {
        setBdRevenue(String(target.total_amount)); setBdCurrency(target.currency || 'USD')
      } else if (sell != null && orderQty) {
        setBdRevenue(String(r2(sell * orderQty))); setBdCurrency('CNY')
      } else { setBdRevenue(''); setBdCurrency(target.currency || 'CNY') }
      setBdRate('')
      setBdLines(qLines.map(l => ({
        bucket: l.bucket, name: l.name, supplier: l.supplier || '',
        qty: orderQty != null ? String(orderQty) : '', unit: '件',
        unit_price: String(l.amount ?? ''),          // 单件金额作单价
        amount: orderQty != null ? String(r2((l.amount || 0) * orderQty)) : String(l.amount ?? ''),
      })))
    } else {
      setBdRevenue(String(q?.total_revenue ?? target.total_amount ?? ''))
      setBdCurrency(q?.currency || target.currency || 'USD')
      setBdRate(q?.exchange_rate != null ? String(q.exchange_rate) : '')
      setBdLines(qLines.map(l => ({
        bucket: l.bucket, name: l.name, supplier: l.supplier || '',
        qty: l.qty != null ? String(l.qty) : '', unit: l.unit || '',
        unit_price: l.unit_price != null ? String(l.unit_price) : '',
        amount: String(l.amount ?? ''),
      })))
    }
    setBdOpen(true)
  }

  const setBdLine = (i: number, patch: Partial<DraftLine>) => setBdLines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l))

  const saveBudgetDraft = async () => {
    if (!bdTarget) { toast.error('请选择要建预算的订单'); return }
    const rev = Number(bdRevenue)
    if (!rev || rev <= 0) { toast.error('请填写售价总额(原币)'); return }
    if (bdCurrency !== 'CNY' && !Number(bdRate)) { toast.error('外币订单请填写汇率(算利润用)'); return }
    const costLines: QuoteCostLineUI[] = bdLines
      .map(l => ({
        bucket: l.bucket, name: l.name.trim(), supplier: l.supplier.trim() || null,
        qty: l.qty ? Number(l.qty) : null, unit: l.unit || null,
        unit_price: l.unit_price ? Number(l.unit_price) : null,
        amount: lineAmount(l),
      }))
      .filter(l => l.name && l.amount > 0)
    if (costLines.length === 0) { toast.error('至少需要一条有效成本行(金额>0)'); return }
    setBdSaving(true)
    const res = await createBudgetFromQuote({
      syncedOrderId: bdTarget,
      revenue: rev, currency: bdCurrency,
      exchangeRate: bdCurrency === 'CNY' ? 1 : Number(bdRate),
      quantity: bdQty ? Number(bdQty) : null,
      costLines,
      sourceDocumentId: bdSourceDoc,
      purchaseOrderId: sel?.purchase_order_id || null,
    })
    setBdSaving(false)
    if (!res.ok) { toast.error(`建预算失败：${res.error}`); return }
    toast.success('预算草稿已生成(去「订单成本核算」提交审批;本单可继续审批放行)')
    setBdOpen(false)
    if (sel) {
      const { lines: bl, orders } = await loadBudgetLines(sel)
      setBudget(bl); setLinkedOrders(orders)
    }
  }

  // 预算对照汇总
  const matchedBudget = (budget || []).filter(l => supMatch(l.supplier, sel?.supplier_name))
  const budgetTotal = r2(matchedBudget.reduce((s, l) => s + (l.amount || 0), 0))
  const poTotal = Number(sel?.total_amount) || 0
  const over = budgetTotal > 0 && poTotal > budgetTotal

  return (
    <div className="flex flex-col h-full">
      <Header title="采购审批" subtitle="所有采购单均需财务审核 · 看预算对照 + 原辅料历史采购价,快速批/驳" />
      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {/* 左:待审列表 */}
          <Card>
            <CardContent className="p-2 space-y-1 max-h-[78vh] overflow-auto">
              <div className="px-2 py-2 text-xs text-muted-foreground">待审批 ({pos.length})</div>
              {loading ? (
                <div className="p-6 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
              ) : pos.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  <Inbox className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  暂无待审批采购单
                  <p className="text-[11px] mt-1">节拍器下单时会推到这里,所有采购单均需财务审批。</p>
                </div>
              ) : (() => {
                // #2 按内部订单号分组:一个订单号下集中展示它的各张采购单
                const groups = new Map<string, PendingPO[]>()
                for (const p of pos) {
                  const key = p.internal_order_no || p.qm_order_no || '未关联订单'
                  if (!groups.has(key)) groups.set(key, [])
                  groups.get(key)!.push(p)
                }
                return [...groups.entries()].map(([key, items]) => {
                  const total = items.reduce((s, p) => s + (Number(p.total_amount) || 0), 0)
                  const cur = items[0]?.currency || 'RMB'
                  const qm = items.find(p => p.qm_order_no)?.qm_order_no
                  const open = collapsed[key] !== true
                  return (
                    <div key={key} className="rounded-lg border overflow-hidden">
                      <button onClick={() => setCollapsed(c => ({ ...c, [key]: open }))}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left bg-muted/30 hover:bg-muted/50 transition">
                        <div className="min-w-0">
                          <div className="font-semibold text-sm flex items-center gap-1">
                            {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                            <span className="truncate">订单 {key}</span>
                          </div>
                          {qm && qm !== key && <div className="text-[11px] text-muted-foreground ml-[18px]">{qm}</div>}
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-xs font-semibold tabular-nums">{cur} {money(total)}</div>
                          <div className="text-[11px] text-muted-foreground">{items.length} 张采购单</div>
                        </div>
                      </button>
                      {open && (
                        <div className="p-1.5 space-y-1">
                          {items.map(p => (
                            <button key={p.id} onClick={() => setSelId(p.id)}
                              className={`w-full text-left rounded-md border p-2.5 transition ${selId === p.id ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted/50'}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm">{p.supplier_name || <span className="text-amber-600">未带供应商</span>}</span>
                                <span className="font-semibold text-sm tabular-nums">{p.currency} {money(p.total_amount)}</span>
                              </div>
                              <div className="mt-0.5 text-xs text-muted-foreground">{p.po_no} · 交期 {fmtDate(p.delivery_date)}</div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              })()}
            </CardContent>
          </Card>

          {/* 右:审批详情 */}
          {!sel ? (
            <Card><CardContent className="p-10 text-center text-muted-foreground">选择左侧一张采购单开始审批</CardContent></Card>
          ) : (
            <div className="space-y-4">
              {/* 头 + 预算对照 */}
              <Card>
                <CardContent className="p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{sel.po_no}</div>
                      <p className="text-xs text-muted-foreground mt-1">
                        供应商 {sel.supplier_name || '—'} · 交期 {fmtDate(sel.delivery_date)}
                        {sel.payment_terms ? ` · 账期 ${sel.payment_terms}` : ''}
                        {(sel.internal_order_no || sel.qm_order_no) ? ` · 关联 ${[sel.internal_order_no, sel.qm_order_no].filter(Boolean).join(' / ')}` : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold tabular-nums">{sel.currency} {money(sel.total_amount)}</div>
                    </div>
                  </div>

                  {/* 节拍器 payload 缺字段时诚实提示(供应商名/明细未回传时,财务无从核对) */}
                  {(!sel.supplier_name || (!linesLoading && lines.length === 0)) && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 space-y-1">
                      <div className="font-medium">⚠️ 节拍器仅回传了单头金额,以下未附带:</div>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {!sel.supplier_name && <li>供应商名{sel.supplier_id ? `(仅收到 id:${sel.supplier_id})` : ''} —— 无法对账/看付款条件</li>}
                        {!linesLoading && lines.length === 0 && <li>原辅料明细行 —— 无法逐料看数量/单价/历史采购价、无法按料做预算对照</li>}
                      </ul>
                      <div className="text-amber-700/80">需节拍器在采购审批推送(<code>purchase_order.approval_requested</code>)里补 <code>supplier_name</code> + <code>lines[]</code>,财务这边收到即自动落库显示。</div>
                    </div>
                  )}

                  {/* 预算闸门:关联订单没有预算单 → 先生成才能批 */}
                  {!budgetLoading && missingBudget.length > 0 && (
                    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 flex flex-wrap items-center gap-2">
                      <Wallet className="h-4 w-4 shrink-0" />
                      <span className="font-medium">关联订单 {missingBudget.map(o => o.internal || o.qm || o.id.slice(0, 8)).join('、')} 还没有预算单</span>
                      <span className="text-xs">—— 按流程须先生成预算单才能批准放行本采购。</span>
                      <Button size="sm" className="ml-auto h-7" onClick={openBudgetDraft}>
                        <Plus className="h-3.5 w-3.5 mr-1" />生成预算草稿{quoteReady ? '(已按报价单预填)' : ''}
                      </Button>
                    </div>
                  )}

                  {/* 预算对照 */}
                  <div className="rounded-lg border bg-muted/20 p-3">
                    <div className="flex items-center gap-2 text-sm mb-2">
                      <span className="font-medium">预算对照</span>
                      {budgetLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> :
                        <span className="text-muted-foreground text-xs">供应商「{sel.supplier_name || '—'}」在关联订单预算里匹配 {matchedBudget.length} 行</span>}
                    </div>
                    {!budgetLoading && (
                      matchedBudget.length === 0 ? (
                        <p className="text-xs text-muted-foreground">未匹配到该供应商的预算行(可能采购单未关联到本系统订单,或预算未按此供应商分解)。</p>
                      ) : (
                        <div className="flex flex-wrap items-center gap-4 text-sm">
                          <span>预算合计:<b className="tabular-nums">¥{money(budgetTotal)}</b></span>
                          <span>采购单金额:<b className="tabular-nums">{sel.currency} {money(sel.total_amount)}</b></span>
                          {budgetTotal > 0 && poTotal > 0 && (
                            over
                              ? <Badge className="bg-red-100 text-red-700 border-0">超预算 ¥{money(r2(poTotal - budgetTotal))}（{Math.round((poTotal / budgetTotal) * 100)}%）</Badge>
                              : <Badge className="bg-green-100 text-green-700 border-0">在预算内（{Math.round((poTotal / budgetTotal) * 100)}%）</Badge>
                          )}
                        </div>
                      )
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* 附件 + 内部报价单识别(节拍器随 PO 推送;AI 只识别建议,落库须财务确认) */}
              <Card>
                <CardContent className="p-0">
                  <div className="px-4 py-2 text-sm font-medium border-b flex items-center gap-2">
                    <Paperclip className="h-4 w-4" />附件与内部报价单
                    <span className="text-xs text-muted-foreground font-normal">PO 单据 + 内部报价单;报价单识别后可一键预填预算草稿</span>
                  </div>
                  {attsLoading ? (
                    <div className="p-6 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
                  ) : atts.length === 0 ? (
                    <div className="p-4 text-xs text-muted-foreground">
                      此采购单没有附件。需节拍器在 <code>purchase_order.approval_requested</code> 里带 <code>attachments[]</code>(file_url + doc_hint)，或用 <code>file.uploaded</code> 事件补发(带 purchase_order_id)。
                    </div>
                  ) : (
                    <div className="p-3 space-y-2">
                      {atts.map(a => {
                        const q = quotes[a.id]
                        const isQuote = a.doc_hint === 'internal_quote'
                        return (
                          <div key={a.id} className="rounded-lg border">
                            <div className="flex items-center gap-2 px-3 py-2">
                              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                              <span className="text-sm truncate">{a.file_name}</span>
                              <Badge variant="outline" className="text-[10px] shrink-0">
                                {a.doc_hint === 'po' ? 'PO单据' : isQuote ? '内部报价单' : a.doc_hint || '附件'}
                              </Badge>
                              <div className="ml-auto flex gap-1 shrink-0">
                                {a.file_url && <Button size="sm" variant="ghost" className="h-7" onClick={() => openAttachment(a.file_url!)}>查看</Button>}
                                {isQuote && (
                                  q === 'loading'
                                    ? <Button size="sm" variant="outline" className="h-7" disabled><Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />识别中…</Button>
                                    : q ? <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => doExtract(a, true)}>重新识别</Button>
                                    : <Button size="sm" variant="outline" className="h-7" onClick={() => doExtract(a)}><Sparkles className="h-3.5 w-3.5 mr-1" />识别报价单</Button>
                                )}
                              </div>
                            </div>
                            {/* 识别结果:售价 + 成本行 + 与PO行的价差对照(多款可切,单件口径标识) */}
                            {q && q !== 'loading' && (() => {
                              const styles = q.styles || []
                              const st = styles[qStyleIdx] || styles[0]
                              const showLines = st?.cost_lines || q.cost_lines
                              const showSell = st?.sell_price ?? q.sell_price
                              const showCost = st?.unit_cost ?? q.cost_total
                              return (
                              <div className="border-t px-3 py-2 space-y-2 bg-muted/20">
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                  {q.per_unit && <Badge className="bg-blue-100 text-blue-700 border-0 text-[10px]">单件口径(每件¥,预算×订单数量)</Badge>}
                                  <span>订单/客户：<b>{q.order_no || q.style_no || q.customer_name || '—'}</b></span>
                                  <span>售价：<b className="tabular-nums">{q.per_unit ? '¥' : (q.currency || '')} {showSell != null ? money(showSell) : '—'}/件{q.total_revenue != null ? ` · 总额 ${money(q.total_revenue)}` : ''}</b></span>
                                  <span>成本{q.per_unit ? '/件' : '合计'}：<b className="tabular-nums">¥{money(showCost)}</b></span>
                                </div>
                                {styles.length > 1 && (
                                  <div className="flex flex-wrap gap-1">
                                    {styles.map((s, i) => (
                                      <button key={i} onClick={() => setQStyleIdx(i)}
                                        className={`text-[11px] px-2 py-1 rounded-md border transition ${i === qStyleIdx ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-muted'}`}>
                                        {s.style_label}{s.sell_price != null ? ` ·¥${money(s.sell_price)}` : ''}
                                      </button>
                                    ))}
                                  </div>
                                )}
                                <div className="rounded-md border bg-background overflow-x-auto">
                                  <Table>
                                    <TableHeader><TableRow>
                                      <TableHead className="text-xs">类别</TableHead>
                                      <TableHead className="text-xs">明细</TableHead>
                                      <TableHead className="text-xs">供应商</TableHead>
                                      <TableHead className="text-xs text-right">数量</TableHead>
                                      <TableHead className="text-xs text-right">单价</TableHead>
                                      <TableHead className="text-xs text-right">金额¥</TableHead>
                                      <TableHead className="text-xs text-right">vs 本采购单</TableHead>
                                    </TableRow></TableHeader>
                                    <TableBody>
                                      {showLines.map((l, i) => {
                                        // 与 PO 行按物料名互含匹配 → 单价差(PO 可能和报价不一样,审的就是这个)
                                        const po = lines.find(pl => {
                                          const a1 = norm(pl.material_name), b1 = norm(l.name)
                                          return !!a1 && !!b1 && (a1.includes(b1) || b1.includes(a1))
                                        })
                                        const diff = po && po.unit_price != null && l.unit_price != null ? r2(po.unit_price - l.unit_price) : null
                                        return (
                                          <TableRow key={i}>
                                            <TableCell className="text-xs">{BUCKET_LABELS[l.bucket] || l.bucket}</TableCell>
                                            <TableCell className="text-xs">{l.name}</TableCell>
                                            <TableCell className="text-xs text-muted-foreground">{l.supplier || '-'}</TableCell>
                                            <TableCell className="text-xs text-right tabular-nums">{l.qty != null ? `${money(l.qty)}${l.unit || ''}` : '-'}</TableCell>
                                            <TableCell className="text-xs text-right tabular-nums">{l.unit_price != null ? money(l.unit_price) : '-'}</TableCell>
                                            <TableCell className="text-xs text-right tabular-nums font-medium">{money(l.amount)}</TableCell>
                                            <TableCell className={`text-xs text-right tabular-nums ${diff == null ? 'text-muted-foreground' : diff > 0 ? 'text-red-600 font-medium' : diff < 0 ? 'text-green-600' : ''}`}>
                                              {diff == null ? '未匹配' : diff === 0 ? '一致' : `${diff > 0 ? '+' : ''}${money(diff)}/单价`}
                                            </TableCell>
                                          </TableRow>
                                        )
                                      })}
                                    </TableBody>
                                  </Table>
                                </div>
                                <p className="text-[11px] text-muted-foreground">红=采购单价高于报价(重点核);绿=低于报价。识别是 AI 建议,以你调价确认后的预算为准。</p>
                              </div>
                              )
                            })()}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* 原辅料明细 + 历史采购价 */}
              <Card>
                <CardContent className="p-0">
                  <div className="px-4 py-2 text-sm font-medium border-b flex items-center gap-2">
                    <PackageCheck className="h-4 w-4" />原辅料明细
                    <span className="text-xs text-muted-foreground font-normal">点某一料看它的历史采购价(谁家买过、什么价)</span>
                  </div>
                  {linesLoading ? (
                    <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
                  ) : lines.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">此采购单未带明细行(仅单头金额)。</div>
                  ) : (
                    <Table>
                      <TableHeader><TableRow>
                        <TableHead className="w-8"></TableHead>
                        <TableHead>物料</TableHead>
                        <TableHead>规格</TableHead>
                        <TableHead className="text-right">数量</TableHead>
                        <TableHead className="text-right">单价</TableHead>
                        <TableHead className="text-right">金额</TableHead>
                      </TableRow></TableHeader>
                      <TableBody>
                        {lines.map(l => {
                          const h = history[l.id]
                          const expanded = expandedMat === l.id
                          return (
                            <Fragment key={l.id}>
                              <TableRow className="cursor-pointer" onClick={() => toggleMat(l)}>
                                <TableCell className="text-muted-foreground">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                                <TableCell className="text-sm font-medium">
                                  {l.material_name || l.material_code || '—'}
                                  {l.style_no ? <span className="text-xs text-muted-foreground ml-1">/ {l.style_no}</span> : ''}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">{l.specification || '-'}</TableCell>
                                <TableCell className="text-right text-sm tabular-nums">{l.ordered_qty != null ? `${money(l.ordered_qty)}${l.ordered_unit || ''}` : '-'}</TableCell>
                                <TableCell className="text-right text-sm tabular-nums">{l.unit_price != null ? money(l.unit_price) : '-'}</TableCell>
                                <TableCell className="text-right text-sm tabular-nums">{money(l.amount)}</TableCell>
                              </TableRow>
                              {expanded && (
                                <TableRow className="bg-muted/20">
                                  <TableCell colSpan={6} className="px-4 py-3">
                                    <div className="flex items-center gap-2 text-xs font-medium mb-2"><History className="h-3.5 w-3.5" />历史采购价 · {l.material_name || l.material_code}</div>
                                    {h === 'loading' || h === undefined ? (
                                      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />查询历史采购…</div>
                                    ) : h.length === 0 ? (
                                      <p className="text-xs text-muted-foreground">无历史采购记录(这是该物料第一次采购,或历史采购未带明细)。</p>
                                    ) : (
                                      <div className="rounded-md border overflow-x-auto bg-background">
                                        <Table>
                                          <TableHeader><TableRow>
                                            <TableHead className="text-xs">下单日</TableHead>
                                            <TableHead className="text-xs">供应商</TableHead>
                                            <TableHead className="text-xs">采购单</TableHead>
                                            <TableHead className="text-xs">规格</TableHead>
                                            <TableHead className="text-xs text-right">单价</TableHead>
                                            <TableHead className="text-xs text-right">数量</TableHead>
                                          </TableRow></TableHeader>
                                          <TableBody>
                                            {h.slice(0, 12).map((r, i) => {
                                              const cheaper = l.unit_price != null && r.unit_price != null && r.unit_price < l.unit_price
                                              const dearer = l.unit_price != null && r.unit_price != null && r.unit_price > l.unit_price
                                              return (
                                                <TableRow key={i}>
                                                  <TableCell className="text-xs">{fmtDate(r.placed_at)}</TableCell>
                                                  <TableCell className="text-xs">{r.supplier_name || '-'}</TableCell>
                                                  <TableCell className="text-xs text-muted-foreground">{r.po_no || '-'}</TableCell>
                                                  <TableCell className="text-xs text-muted-foreground">{r.specification || '-'}</TableCell>
                                                  <TableCell className={`text-xs text-right tabular-nums ${cheaper ? 'text-green-600' : dearer ? 'text-red-600' : ''}`}>
                                                    {r.unit_price != null ? money(r.unit_price) : '-'}{r.ordered_unit ? `/${r.ordered_unit}` : ''}
                                                  </TableCell>
                                                  <TableCell className="text-xs text-right tabular-nums">{r.ordered_qty != null ? money(r.ordered_qty) : '-'}</TableCell>
                                                </TableRow>
                                              )
                                            })}
                                          </TableBody>
                                        </Table>
                                        <p className="text-[11px] text-muted-foreground px-2 py-1">绿=比本次便宜、红=比本次贵。{h.length > 12 ? `仅显示最近 12 条(共 ${h.length} 条)。` : ''}</p>
                                      </div>
                                    )}
                                  </TableCell>
                                </TableRow>
                              )}
                            </Fragment>
                          )
                        })}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              {/* 审批操作(预算闸门:关联订单须先有预算单才可批准;驳回不受限) */}
              <div className="flex items-center justify-end gap-2 pb-6">
                {missingBudget.length > 0 && <span className="text-xs text-amber-700 mr-1">先生成预算单才能批准放行 →</span>}
                <Button variant="outline" className="text-destructive" onClick={() => { setDecideDlg('rejected'); setNote('') }}><Ban className="h-4 w-4 mr-1" />驳回</Button>
                <Button disabled={budgetLoading || missingBudget.length > 0} onClick={() => { setDecideDlg('approved'); setNote('') }}><ShieldCheck className="h-4 w-4 mr-1" />批准放行</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 生成预算草稿:识别结果预填,财务调价确认落库(真实登录人) */}
      <Dialog open={bdOpen} onOpenChange={setBdOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader><DialogTitle>生成预算草稿 — 报价单预填 · 请核对并调价</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1 max-h-[70vh] overflow-y-auto">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <div className="space-y-1 col-span-2 md:col-span-1"><Label className="text-xs">目标订单 *</Label>
                <Select value={bdTarget} onValueChange={v => v && setBdTarget(v)}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="选订单">{(id) => { const o = missingBudget.find(x => x.id === id); return o ? (o.internal || o.qm || '') : '' }}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {missingBudget.map(o => <SelectItem key={o.id} value={o.id}>{o.internal || o.qm || o.id.slice(0, 8)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1"><Label className="text-xs">售价总额(原币) *</Label><Input className="h-8" type="number" step="0.01" value={bdRevenue} onChange={e => setBdRevenue(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">币种</Label><Input className="h-8" value={bdCurrency} onChange={e => setBdCurrency(e.target.value.toUpperCase())} /></div>
              <div className="space-y-1"><Label className="text-xs">汇率{bdCurrency !== 'CNY' ? ' *' : ''}</Label><Input className="h-8" type="number" step="0.0001" value={bdCurrency === 'CNY' ? '1' : bdRate} disabled={bdCurrency === 'CNY'} onChange={e => setBdRate(e.target.value)} placeholder="如 6.7812" /></div>
              <div className="space-y-1"><Label className="text-xs">数量(件)</Label><Input className="h-8" type="number" value={bdQty} onChange={e => setBdQty(e.target.value)} /></div>
            </div>

            <div className="rounded-md border">
              <div className="grid grid-cols-[110px_1fr_130px_90px_90px_100px_32px] gap-2 px-2 py-1.5 text-xs text-muted-foreground border-b bg-muted/40">
                <span>类别</span><span>明细</span><span>供应商</span><span className="text-right">数量</span><span className="text-right">单价¥</span><span className="text-right">金额¥</span><span />
              </div>
              <div className="space-y-1.5 p-2">
                {bdLines.map((l, i) => (
                  <div key={i} className="grid grid-cols-[110px_1fr_130px_90px_90px_100px_32px] gap-2 items-center">
                    <Select value={l.bucket} onValueChange={v => v && setBdLine(i, { bucket: v })}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue>{(v) => BUCKET_LABELS[v as string] || String(v || '')}</SelectValue></SelectTrigger>
                      <SelectContent>{Object.entries(BUCKET_LABELS).map(([k, lab]) => <SelectItem key={k} value={k}>{lab}</SelectItem>)}</SelectContent>
                    </Select>
                    <Input className="h-8 text-xs" value={l.name} onChange={e => setBdLine(i, { name: e.target.value })} placeholder="面料/辅料/工序" />
                    <Input className="h-8 text-xs" value={l.supplier} onChange={e => setBdLine(i, { supplier: e.target.value })} placeholder="供应商" />
                    <Input className="h-8 text-xs text-right" type="number" step="0.01" value={l.qty} onChange={e => setBdLine(i, { qty: e.target.value })} />
                    <Input className="h-8 text-xs text-right" type="number" step="0.0001" value={l.unit_price} onChange={e => setBdLine(i, { unit_price: e.target.value })} />
                    <Input className="h-8 text-xs text-right font-medium" type="number" step="0.01" value={l.qty && l.unit_price ? String(lineAmount(l)) : l.amount} disabled={!!(l.qty && l.unit_price)} onChange={e => setBdLine(i, { amount: e.target.value })} />
                    <Button size="sm" variant="ghost" className="h-8 px-1 text-muted-foreground" onClick={() => setBdLines(ls => ls.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setBdLines(ls => [...ls, { bucket: 'other', name: '', supplier: '', qty: '', unit: '', unit_price: '', amount: '' }])}><Plus className="h-3 w-3 mr-1" />加一行</Button>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-4 px-3 py-2 border-t text-sm">
                <span>成本合计 <b className="tabular-nums">¥{money(bdCostTotal)}</b></span>
                {bdProfit
                  ? <span className={bdProfit.profit >= 0 ? 'text-green-700' : 'text-red-600'}>预估利润 <b className="tabular-nums">¥{money(bdProfit.profit)}（{bdProfit.margin}%）</b></span>
                  : <span className="text-xs text-muted-foreground">填售价+汇率后显示预估利润</span>}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">保存为预算单<b>草稿</b>，记你为创建人；之后在「订单成本核算」提交审批，走正常预算审批流。数量×单价会自动算金额；没有数量单价的行直接填金额。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBdOpen(false)}>取消</Button>
            <Button onClick={saveBudgetDraft} disabled={bdSaving}>{bdSaving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wallet className="h-4 w-4 mr-1" />}保存预算草稿</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批/驳弹窗 */}
      <Dialog open={!!decideDlg} onOpenChange={o => !o && setDecideDlg(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{decideDlg === 'approved' ? '批准放行采购' : '驳回采购'} · {sel?.po_no}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/50 p-3 text-sm flex justify-between">
              <span className="text-muted-foreground">{sel?.supplier_name}</span>
              <span className="font-bold">{sel?.currency} {money(sel?.total_amount)}</span>
            </div>
            {over && decideDlg === 'approved' && (
              <p className="text-xs text-red-600">⚠️ 本采购超预算 ¥{money(r2(poTotal - budgetTotal))}，确认仍批准放行？</p>
            )}
            <div className="space-y-1">
              <label className="text-sm">{decideDlg === 'rejected' ? '驳回原因（会回传节拍器给采购）' : '审批意见（可选）'}</label>
              <Textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder={decideDlg === 'rejected' ? '如：单价高于历史采购价，请重新议价' : ''} />
            </div>
            <p className="text-[11px] text-muted-foreground">结果会回传节拍器：批准→采购放行下单；驳回→采购被拦下。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecideDlg(null)}>取消</Button>
            <Button onClick={doDecide} disabled={busy || (decideDlg === 'rejected' && !note.trim())}
              className={decideDlg === 'approved' ? '' : 'bg-destructive hover:bg-destructive/90'}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : decideDlg === 'approved' ? <ShieldCheck className="h-4 w-4 mr-1" /> : <Ban className="h-4 w-4 mr-1" />}
              确认{decideDlg === 'approved' ? '批准' : '驳回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
