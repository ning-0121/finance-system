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
  approval_type: 'price' | 'delay' | 'cancel' | 'milestone'
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
}

function fmtDate(v: unknown): string {
  try { const d = new Date(v as string); return isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false }) } catch { return String(v) }
}
function fmtVal(k: string, v: unknown): string {
  if (v == null || v === '') return '—'
  if (k === 'step_key') return STEP_LABEL[v as string] || String(v)
  if (k === 'milestone_status') return MS_LABEL[v as string] || String(v)
  if (/(_at$|^due)/.test(k)) return fmtDate(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
function toPairs(obj: unknown): [string, string][] {
  if (obj == null) return []
  if (typeof obj !== 'object') return [['说明', String(obj)]]
  return Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [KEY_LABEL[k] || k, fmtVal(k, v)] as [string, string])
}

export function IntegrationApprovals({ userId, userName }: { userId: string; userName: string }) {
  const [rows, setRows] = useState<PendingApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<PendingApproval | null>(null)   // 打开详情+审批的行
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null)

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
        <p className="text-xs text-muted-foreground">价格 / 延期 / 取消订单 / 里程碑 —— 点行查看详情,财务批/驳后自动回传节拍器执行。</p>
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
        <DialogContent className="max-w-lg">
          {sel && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Badge className={TYPE_LABEL[sel.approval_type]?.color} variant="secondary">{TYPE_LABEL[sel.approval_type]?.label || sel.approval_type}</Badge>
                  <span>{sel.summary}</span>
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
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
                </div>
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
              <DialogFooter className="gap-2">
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
