'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, ShieldCheck, Ban, ChevronRight, ChevronDown, History, PackageCheck, Inbox } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import {
  getPendingPurchaseApprovals, getPoLines, getMaterialPriceHistory, decidePurchaseApproval,
  type PendingPO, type PoLine, type PriceHistoryRow,
} from '@/lib/supabase/purchase-approvals'
import { PURCHASE_APPROVAL_THRESHOLD_CNY } from '@/lib/integration/purchase-approval'

interface BLine { bucket: string; name: string; supplier?: string; qty?: number; unit?: string; unit_price?: number; amount?: number }
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

  const sel = pos.find(p => p.id === selId) || null

  const loadPending = useCallback(async () => {
    setLoading(true)
    const list = await getPendingPurchaseApprovals()
    setPos(list)
    setSelId(prev => prev && list.some(p => p.id === prev) ? prev : (list[0]?.id || null))
    setLoading(false)
  }, [])

  useEffect(() => { loadPending() }, [loadPending])

  // 选中某采购单 → 载明细行 + 预算对照
  useEffect(() => {
    if (!sel) { setLines([]); setBudget(null); return }
    setExpandedMat(null); setHistory({})
    ;(async () => {
      setLinesLoading(true)
      setLines(await getPoLines(sel.id))
      setLinesLoading(false)
    })()
    ;(async () => {
      setBudgetLoading(true)
      setBudget(await loadBudgetLines(sel))
      setBudgetLoading(false)
    })()
  }, [selId]) // eslint-disable-line react-hooks/exhaustive-deps

  // order_refs(QM号) → synced_orders.budget_order_id → budget_orders._cost_breakdown.lines
  const loadBudgetLines = async (po: PendingPO): Promise<BLine[]> => {
    try {
      const refs = Array.isArray(po.order_refs) ? (po.order_refs as unknown[]).map(String).map(s => s.trim()).filter(Boolean) : []
      if (refs.length === 0) return []
      const sb = createClient()
      const { data: synced } = await sb.from('synced_orders').select('order_no, budget_order_id').in('order_no', refs).not('budget_order_id', 'is', null)
      const boIds = [...new Set((synced || []).map(s => (s as Record<string, unknown>).budget_order_id as string).filter(Boolean))]
      if (boIds.length === 0) return []
      const { data: bos } = await sb.from('budget_orders').select('items').in('id', boIds)
      const flat: BLine[] = []
      for (const bo of bos || []) {
        const cb = ((bo.items as Record<string, unknown>[] | null)?.[0]?._cost_breakdown) as Record<string, unknown> | undefined
        const ls = (cb?.lines as Record<string, BLine[]> | undefined) || {}
        for (const [bucket, arr] of Object.entries(ls)) for (const l of (arr || [])) flat.push({ ...l, bucket })
      }
      return flat
    } catch { return [] }
  }

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

  // 预算对照汇总
  const matchedBudget = (budget || []).filter(l => supMatch(l.supplier, sel?.supplier_name))
  const budgetTotal = r2(matchedBudget.reduce((s, l) => s + (l.amount || 0), 0))
  const poTotal = Number(sel?.total_amount) || 0
  const over = budgetTotal > 0 && poTotal > budgetTotal

  return (
    <div className="flex flex-col h-full">
      <Header title="采购审批" subtitle={`单张 ≥¥${PURCHASE_APPROVAL_THRESHOLD_CNY.toLocaleString()} 的采购需财务审核 · 看预算对照 + 原辅料历史采购价,快速批/驳`} />
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
                  <p className="text-[11px] mt-1">节拍器下单、单张 ≥¥{PURCHASE_APPROVAL_THRESHOLD_CNY.toLocaleString()} 时会推到这里。</p>
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
                        {Array.isArray(sel.order_refs) && (sel.order_refs as unknown[]).length ? ` · 关联 ${(sel.order_refs as unknown[]).map(String).join(', ')}` : ''}
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

              {/* 审批操作 */}
              <div className="flex items-center justify-end gap-2 pb-6">
                <Button variant="outline" className="text-destructive" onClick={() => { setDecideDlg('rejected'); setNote('') }}><Ban className="h-4 w-4 mr-1" />驳回</Button>
                <Button onClick={() => { setDecideDlg('approved'); setNote('') }}><ShieldCheck className="h-4 w-4 mr-1" />批准放行</Button>
              </div>
            </div>
          )}
        </div>
      </div>

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
