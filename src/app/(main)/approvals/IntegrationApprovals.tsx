'use client'

// ============================================================
// 集成审批队列(来自节拍器):price/delay/cancel/milestone 审批请求。
// 此前只入 pending_approvals 表却无 UI 可决策 → 死信队列(审计#8)。
// 2026-07-08:每行可点开 → 详情弹窗(把 detail/form_snapshot 用中文铺开,
//   财务看清"批的是什么"再决策)。批/驳 → POST /api/integration/approve。
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { CheckCircle, XCircle, Loader2, Inbox, Eye, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

interface PendingApproval {
  id: string
  approval_type: 'price' | 'delay' | 'cancel' | 'milestone' | 'shipment'
  order_no: string
  customer_name: string | null
  requested_by_name: string | null
  summary: string
  detail: unknown
  form_snapshot: unknown
  created_at: string
  source_created_at: string | null
}

const TYPE_LABEL: Record<string, { label: string; color: string }> = {
  price: { label: '价格审批', color: 'bg-purple-100 text-purple-700' },
  delay: { label: '延期审批', color: 'bg-amber-100 text-amber-700' },
  cancel: { label: '取消订单', color: 'bg-red-100 text-red-700' },
  milestone: { label: '里程碑确认', color: 'bg-blue-100 text-blue-700' },
  shipment: { label: '出货审批', color: 'bg-teal-100 text-teal-700' },
}

// 节拍器环节 step_key → 中文
const STEP_LABEL: Record<string, string> = {
  processing_fee_confirmed: '加工费确认',
  finance_shipment_approval: '核准出运（财务）',
  payment_received: '收款完成',
  finance_approval: '财务审核',
  price_confirmed: '价格确认',
}
const MS_LABEL: Record<string, string> = { pending: '待处理', done: '已完成', blocked: '阻塞中', in_progress: '进行中', rejected: '已驳回' }
const KEY_LABEL: Record<string, string> = {
  step_key: '审批环节', due_at: '截止时间', milestone_status: '里程碑状态', notes: '备注',
  reason: '原因', old_price: '原价', new_price: '新价', old_unit_price: '原单价', new_unit_price: '新单价',
  currency: '币种', delay_days: '延期天数', amount: '金额', qty: '数量', new_due_at: '新截止时间', old_due_at: '原截止时间',
  // 节拍器审批 detail 若带本次金额,自动以中文显示(加工费确认/价格审批等)
  processing_amount: '本次加工费', processing_fee: '本次加工费', per_piece: '单件加工费', unit_price: '单价',
  total_amount: '总额', fee: '费用', delta: '差额', variance_pct: '差异%', supplier_name: '供应商', material_name: '物料',
  // 出货审批 detail(2026-07-11)
  shipment_qty: '出货数量', carton_count: '出货箱数', order_qty: '订单数量', delivery_method: '交货方式',
  requested_ship_date: '申请出运日', destination_port: '目的港', shipping_port: '起运港', ci_number: 'CI号',
  internal_order_no: '内部订单号', product_name: '品名',
}

function fmtDate(v: unknown): string {
  try { const d = new Date(v as string); return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false }) } catch { return String(v) }
}
// 节拍器快照里会带 po_parse_snapshot(几 KB 的 AI 识别底档,嵌套对象)等大 blob,
// 财务审批用不到,平铺出来只会把弹窗撑爆、把批准/驳回按钮挤到屏幕外。整行隐藏。
const HIDDEN_KEYS = new Set(['po_parse_snapshot', 'po_parse_snapshot_at', 'styles', 'trims', 'measurements'])
function fmtVal(k: string, v: unknown): string {
  if (v == null || v === '') return '—'
  if (k === 'step_key') return STEP_LABEL[v as string] || String(v)
  if (k === 'milestone_status') return MS_LABEL[v as string] || String(v)
  if (/(_at$|^due)/.test(k)) return fmtDate(v)
  if (typeof v === 'object') { const s = JSON.stringify(v); return s.length > 160 ? s.slice(0, 160) + '…' : s }  // 长 JSON 截断,不撑破布局
  return String(v)
}
function toPairs(obj: unknown): [string, string][] {
  if (obj == null) return []
  if (typeof obj !== 'object') return [['说明', String(obj)]]
  return Object.entries(obj as Record<string, unknown>)
    .filter(([k, v]) => v != null && v !== '' && !HIDDEN_KEYS.has(k))
    .map(([k, v]) => [KEY_LABEL[k] || k, fmtVal(k, v)] as [string, string])
}

// cost_items.cost_type → 决算桶(与 cost-buckets 一致)
const CT2BUCKET: Record<string, string> = {
  fabric: '面料', procurement: '面料', accessory: '辅料', processing: '加工费', commission: '加工费',
  freight: '货代费', forwarder: '货代费', container: '装柜费', customs: '装柜费', logistics: '物流费',
}
const BUDGET_KEYS: [string, string][] = [['fabric', '面料'], ['accessory', '辅料'], ['processing', '加工费'], ['forwarder', '货代费'], ['container', '装柜费'], ['logistics', '物流费']]
// 审批环节 → 该环节最该看的决算桶(高亮)。加工费确认→加工费,收款→无,出运→货代/装柜…
const STEP_FOCUS: Record<string, string> = { processing_fee_confirmed: '加工费', finance_shipment_approval: '货代费', price_confirmed: '面料' }
interface OrderSnap { boNo: string | null; internalNo: string | null; qty: number; qtyUnit: string; rows: { label: string; budget: number; actual: number }[] }
const cny = (n: number) => `¥${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`

export function IntegrationApprovals({ userId, userName }: { userId: string; userName: string }) {
  const [rows, setRows] = useState<PendingApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<PendingApproval | null>(null)   // 打开详情+审批的行
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null)
  const [snap, setSnap] = useState<OrderSnap | null>(null)       // 该订单快照 + 预算vs实际决算表
  const [snapLoading, setSnapLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const sb = createClient()
    const { data } = await sb.from('pending_approvals')
      .select('id, approval_type, order_no, customer_name, requested_by_name, summary, detail, form_snapshot, created_at, source_created_at')
      .eq('status', 'pending').order('created_at', { ascending: true })
    setRows((data as PendingApproval[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // 打开某审批 → 拉该 QM 订单的快照(内部单号/款号/数量)+ 预算 vs 实际 决算表,财务凭此判(尤其加工费确认)
  useEffect(() => {
    if (!sel?.order_no) { setSnap(null); return }
    let alive = true
    ;(async () => {
      setSnapLoading(true)
      try {
        const sb = createClient()
        const { data: so } = await sb.from('synced_orders')
          .select('style_no, quantity, quantity_unit, budget_order_id').eq('order_no', sel.order_no).limit(1).maybeSingle()
        const s = so as { style_no?: string; quantity?: number; quantity_unit?: string; budget_order_id?: string } | null
        if (!s?.budget_order_id) {
          if (alive) setSnap({ boNo: null, internalNo: s?.style_no ?? null, qty: Number(s?.quantity) || 0, qtyUnit: s?.quantity_unit || '', rows: [] })
          return
        }
        const [{ data: bo }, { data: ci }] = await Promise.all([
          sb.from('budget_orders').select('order_no, items').eq('id', s.budget_order_id).maybeSingle(),
          sb.from('cost_items').select('cost_type, amount, currency, exchange_rate').eq('budget_order_id', s.budget_order_id).is('deleted_at', null),
        ])
        const cb = ((bo as { items?: Record<string, unknown>[] } | null)?.items?.[0]?._cost_breakdown) as Record<string, number> | undefined
        const actualByBucket: Record<string, number> = {}
        for (const r of (ci as { cost_type?: string; amount?: number; currency?: string; exchange_rate?: number }[] | null) || []) {
          const b = CT2BUCKET[r.cost_type || ''] || '物流费'
          const rate = r.currency === 'CNY' ? 1 : (Number(r.exchange_rate) || 1)
          actualByBucket[b] = (actualByBucket[b] || 0) + (Number(r.amount) || 0) * rate
        }
        // 采购填价兜底(PO 未归集时):_actual_fabric/_actual_accessory/_actual_processing
        const fill: Record<string, number> = { '面料': Number(cb?._actual_fabric) || 0, '辅料': Number(cb?._actual_accessory) || 0, '加工费': Number(cb?._actual_processing) || 0 }
        const rows = BUDGET_KEYS.map(([k, label]) => {
          const budget = Number(cb?.[k]) || 0
          let actual = actualByBucket[label] || 0
          if (actual === 0 && (fill[label] || 0) > 0) actual = fill[label]
          return { label, budget, actual }
        }).filter(r => r.budget > 0 || r.actual > 0)
        if (alive) setSnap({ boNo: (bo as { order_no?: string } | null)?.order_no ?? null, internalNo: s.style_no ?? null, qty: Number(s.quantity) || 0, qtyUnit: s.quantity_unit || '', rows })
      } catch { if (alive) setSnap(null) }
      finally { if (alive) setSnapLoading(false) }
    })()
    return () => { alive = false }
  }, [sel])

  const open = (r: PendingApproval) => { setSel(r); setNote('') }

  const decide = async (action: 'approved' | 'rejected') => {
    if (!sel) return
    if (action === 'rejected' && !note.trim()) { toast.error('驳回请填写原因'); return }
    setBusy(action)
    try {
      const res = await fetch('/api/integration/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approval_id: sel.id,
          approval_type: sel.approval_type,
          decision: action,
          decided_by: userId,
          decider_name: userName,
          decision_note: note.trim() || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || `HTTP ${res.status}`); setBusy(null); return }
      toast[json.callback_sent ? 'success' : 'warning'](
        `已${action === 'approved' ? '批准' : '驳回'}` + (json.callback_sent ? '，已通知节拍器' : '，但回传节拍器失败(已入 outbox 重试)')
      )
      setSel(null); setNote('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally { setBusy(null) }
  }

  const detailPairs = sel ? toPairs(sel.detail) : []
  const formPairs = sel ? toPairs(sel.form_snapshot) : []

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          集成审批（来自节拍器）
          {rows.length > 0 && <Badge className="bg-amber-100 text-amber-700">{rows.length}</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">价格 / 延期 / 取消订单 / 里程碑 / 出货 —— 点行查看详情,财务批/驳后自动回传节拍器执行。</p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Inbox className="h-10 w-10 mx-auto mb-2 opacity-30" /><p className="text-sm">暂无待处理的集成审批</p>
          </div>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>类型</TableHead>
              <TableHead>订单</TableHead>
              <TableHead>摘要</TableHead>
              <TableHead>申请人</TableHead>
              <TableHead className="text-center">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.id} className="cursor-pointer hover:bg-muted/40" onClick={() => open(r)}>
                  <TableCell><Badge className={TYPE_LABEL[r.approval_type]?.color} variant="secondary">{TYPE_LABEL[r.approval_type]?.label || r.approval_type}</Badge></TableCell>
                  <TableCell className="text-sm">
                    <div className="font-medium">{r.order_no}</div>
                    <div className="text-xs text-muted-foreground">{r.customer_name || ''}</div>
                  </TableCell>
                  <TableCell className="text-sm max-w-xs"><span className="line-clamp-2">{r.summary}</span></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.requested_by_name || '-'}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-center">
                      <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); open(r) }}>
                        <Eye className="h-3.5 w-3.5 mr-1" />查看并审批
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {/* 详情 + 审批 弹窗 */}
      <Dialog open={!!sel} onOpenChange={o => !o && !busy && setSel(null)}>
        {/* 2026-07-21:弹窗改「头/尾固定 + 中间滚动」。原来内容一长(如带识别快照),
            底部批准/驳回按钮会掉到屏幕外看不到 → 财务无法审批。 */}
        <DialogContent className="max-w-lg max-h-[88vh] flex flex-col gap-0 p-0">
          {sel && (
            <>
              <DialogHeader className="shrink-0 p-6 pb-3">
                <DialogTitle className="flex items-center gap-2">
                  <Badge className={TYPE_LABEL[sel.approval_type]?.color} variant="secondary">{TYPE_LABEL[sel.approval_type]?.label || sel.approval_type}</Badge>
                  <span>{sel.summary}</span>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 overflow-y-auto flex-1 px-6">
                {/* 基本信息 */}
                <div className="rounded-lg border p-3 text-sm space-y-1.5">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">订单</span>
                    <a href={`/orders?q=${encodeURIComponent(sel.order_no)}`} target="_blank" rel="noreferrer"
                      className="font-medium text-primary inline-flex items-center gap-0.5 hover:underline" onClick={e => e.stopPropagation()}>
                      {sel.order_no} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground">客户</span><span>{sel.customer_name || '—'}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground">申请人</span><span>{sel.requested_by_name || '节拍器'}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground">提交时间</span><span>{fmtDate(sel.source_created_at || sel.created_at)}</span></div>
                  {snap?.internalNo && <div className="flex justify-between gap-2"><span className="text-muted-foreground">内部单号/款号</span><span className="font-medium">{snap.internalNo}</span></div>}
                  {snap && snap.qty > 0 && <div className="flex justify-between gap-2"><span className="text-muted-foreground">数量</span><span>{snap.qty.toLocaleString()} {snap.qtyUnit}</span></div>}
                  {snap?.boNo && <div className="flex justify-between gap-2"><span className="text-muted-foreground">财务预算单</span><span className="font-mono text-xs">{snap.boNo}</span></div>}
                </div>

                {/* 订单决算表:预算 vs 实际(费用归集/采购填价)——财务凭此判,尤其加工费确认 */}
                {snapLoading ? (
                  <div className="rounded-lg border p-3 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载订单决算…</div>
                ) : snap && snap.rows.length > 0 ? (
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold text-muted-foreground mb-2">订单决算 · 预算 vs 实际</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead><tr className="text-muted-foreground border-b">
                          <th className="text-left font-medium py-1">成本类目</th>
                          <th className="text-right font-medium py-1">预算</th>
                          <th className="text-right font-medium py-1">实际</th>
                          <th className="text-right font-medium py-1">差额</th>
                        </tr></thead>
                        <tbody>
                          {snap.rows.map(r => {
                            const focus = STEP_FOCUS[(sel.detail as Record<string, unknown> | null)?.step_key as string] === r.label
                            const diff = r.actual - r.budget
                            return (
                              <tr key={r.label} className={`border-b border-muted/40 ${focus ? 'bg-amber-50 font-semibold' : ''}`}>
                                <td className="py-1">{r.label}{focus ? ' ◀ 本次' : ''}</td>
                                <td className="py-1 text-right">{cny(r.budget)}</td>
                                <td className="py-1 text-right text-amber-700">{r.actual ? cny(r.actual) : '—'}</td>
                                <td className={`py-1 text-right ${r.actual ? (diff > 0 ? 'text-red-600' : 'text-green-600') : 'text-muted-foreground/50'}`}>{r.actual ? `${diff > 0 ? '+' : ''}${cny(diff)}` : '—'}</td>
                              </tr>
                            )
                          })}
                          <tr className="font-semibold border-t-2">
                            <td className="py-1.5">合计</td>
                            <td className="py-1.5 text-right">{cny(snap.rows.reduce((s, r) => s + r.budget, 0))}</td>
                            <td className="py-1.5 text-right text-amber-700">{cny(snap.rows.reduce((s, r) => s + r.actual, 0))}</td>
                            <td className="py-1.5 text-right">{cny(snap.rows.reduce((s, r) => s + (r.actual - r.budget), 0))}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1.5">实际=费用归集(采购/发票已录)或采购填价;差额&gt;0=超预算(红)。加工费确认可看「加工费」行预算vs实际是否吻合。</p>
                  </div>
                ) : snap && !snap.boNo ? (
                  <div className="rounded-lg border p-3 text-xs text-amber-700 bg-amber-50">该 QM 订单尚未同步到财务预算单,暂无预算/决算可对照(内部单号 {snap.internalNo || '—'})。</div>
                ) : null}

                {/* 审批详情 */}
                <div className="rounded-lg bg-muted/50 p-3 text-sm">
                  <p className="text-xs font-semibold text-muted-foreground mb-1.5">审批详情</p>
                  {detailPairs.length ? (
                    <div className="space-y-1">
                      {detailPairs.map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-3">
                          <span className="text-muted-foreground shrink-0">{k}</span>
                          <span className="text-right break-all">{v}</span>
                        </div>
                      ))}
                    </div>
                  ) : <p className="text-xs text-muted-foreground">节拍器未附带明细字段（仅摘要）。可点上方订单号到成本核算页核对。</p>}
                  {formPairs.length > 0 && (
                    <div className="mt-2 pt-2 border-t space-y-1">
                      <p className="text-xs font-semibold text-muted-foreground">表单快照</p>
                      {formPairs.map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-3">
                          <span className="text-muted-foreground shrink-0">{k}</span>
                          <span className="text-right break-all">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* 审批意见 */}
                <Textarea rows={2} value={note} onChange={e => setNote(e.target.value)}
                  placeholder="审批意见（驳回必填,会回传节拍器给申请人）" />
                <p className="text-[11px] text-muted-foreground">结果回传节拍器：批准→节拍器执行；驳回→拦下并显示原因。</p>
              </div>
              <DialogFooter className="gap-2 shrink-0 border-t p-6 pt-3">
                <Button variant="destructive" disabled={!!busy} onClick={() => decide('rejected')}>
                  {busy === 'rejected' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <XCircle className="h-4 w-4 mr-1" />}驳回
                </Button>
                <Button disabled={!!busy} onClick={() => decide('approved')}>
                  {busy === 'approved' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}批准
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
