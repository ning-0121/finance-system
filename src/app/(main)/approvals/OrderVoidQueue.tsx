'use client'

// ============================================================
// 作废审批队列(问题2 · 切片3:财务终审 → 级联软删 + 恢复)
//   待审:批准(finance_manager/admin,🔴须admin+强制勾选)/ 驳回(财务任意)
//   已作废:管理员可「恢复」(按 cascade_result 精确回滚)
// ============================================================
import { useState, useEffect, useCallback, Fragment } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Inbox, ChevronRight, ChevronDown, ShieldAlert, AlertTriangle, ShieldCheck, CheckCircle, XCircle, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useCurrentUser } from '@/lib/hooks/use-current-user'

interface VoidItem { table: string; label: string; level: 'green' | 'amber' | 'red'; count: number; detail: string }
interface VoidRequest {
  id: string; budget_order_id: string; order_no: string | null; qm_order_no: string | null; internal_no: string | null
  source: string; reason: string; severity: 'clean' | 'has_approved' | 'blocked_admin'
  blockers: VoidItem[]; requested_by: string | null; requested_by_name: string | null; requested_at: string
  status: string; decider_name?: string | null; decided_at?: string | null
}

const SEV: Record<VoidRequest['severity'], { label: string; cls: string; icon: React.ReactNode }> = {
  blocked_admin: { label: '🔴 需管理员', cls: 'bg-red-100 text-red-700', icon: <ShieldAlert className="h-3.5 w-3.5" /> },
  has_approved: { label: '🟡 含已审批', cls: 'bg-amber-100 text-amber-700', icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  clean: { label: '🟢 可撤', cls: 'bg-emerald-100 text-emerald-700', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
}
const DOT: Record<VoidItem['level'], string> = { red: 'bg-red-500', amber: 'bg-amber-500', green: 'bg-emerald-500' }
const SRC: Record<string, string> = { finance: '财务', creator: '创建人', metronome: '节拍器' }

export function OrderVoidQueue() {
  const { user } = useCurrentUser()
  const [rows, setRows] = useState<VoidRequest[]>([])
  const [voided, setVoided] = useState<VoidRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [sel, setSel] = useState<VoidRequest | null>(null)   // 终审弹窗对象
  const [note, setNote] = useState('')
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState<'approved' | 'rejected' | 'restore' | null>(null)

  const role = user?.role || ''
  const isAdmin = role === 'admin'
  const canApproveVoid = role === 'finance_manager' || role === 'admin'
  const canReject = ['finance_staff', 'finance_manager', 'admin'].includes(role)

  const load = useCallback(async () => {
    setLoading(true)
    const sb = createClient()
    const cols = 'id, budget_order_id, order_no, qm_order_no, internal_no, source, reason, severity, blockers, requested_by, requested_by_name, requested_at, status, decider_name, decided_at'
    const [{ data: pend }, { data: appr }] = await Promise.all([
      sb.from('order_void_requests').select(cols).eq('status', 'pending').order('requested_at', { ascending: true }),
      sb.from('order_void_requests').select(cols).eq('status', 'approved').order('decided_at', { ascending: false }).limit(20),
    ])
    setRows((pend as VoidRequest[]) || [])
    setVoided((appr as VoidRequest[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const fmt = (s: string | null | undefined) => { if (!s) return '—'; try { return new Date(s).toLocaleString('zh-CN', { hour12: false }) } catch { return s } }

  const openDecide = (r: VoidRequest) => { setSel(r); setNote(''); setForce(false) }

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!sel) return
    if (decision === 'rejected' && !note.trim()) { toast.error('驳回请填写原因'); return }
    setBusy(decision)
    try {
      const res = await fetch('/api/order-void/decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: sel.id, decision, note: note.trim() || null, force }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || `HTTP ${res.status}`); return }
      if (decision === 'approved') {
        const errs = (json.errors || []) as string[]
        errs.length ? toast.warning(`已作废,但有 ${errs.length} 处未完成:${errs[0]}`) : toast.success('订单已作废(软删,可恢复)')
      } else toast.success('已驳回,订单保留')
      setSel(null); await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : '操作失败') } finally { setBusy(null) }
  }

  const restore = async (r: VoidRequest) => {
    setBusy('restore')
    try {
      const res = await fetch('/api/order-void/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: r.id }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || `HTTP ${res.status}`); return }
      const errs = (json.errors || []) as string[]
      errs.length ? toast.warning(`已恢复,但有 ${errs.length} 处未完成`) : toast.success('订单已恢复')
      await load()
    } catch (e) { toast.error(e instanceof Error ? e.message : '恢复失败') } finally { setBusy(null) }
  }

  const selfOwn = (r: VoidRequest) => !!user && r.requested_by === user.id

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          作废审批队列
          {rows.length > 0 && <Badge className="bg-red-100 text-red-700">{rows.length}</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">订单作废申请 · 点行看体检明细。🟢随单撤 · 🟡财务经理确认 · 🔴须先红冲或管理员。批准即级联软删(可恢复)。</p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Inbox className="h-10 w-10 mx-auto mb-2 opacity-30" /><p className="text-sm">暂无待处理的作废申请</p>
          </div>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>订单</TableHead><TableHead>分级</TableHead><TableHead>原因</TableHead>
              <TableHead>发起</TableHead><TableHead className="text-center">终审</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map(r => {
                const sev = SEV[r.severity]; const open = expandedId === r.id
                const items = (r.blockers || []).filter(i => i.count > 0)
                return (
                  <Fragment key={r.id}>
                    <TableRow className="hover:bg-muted/40">
                      <TableCell className="text-muted-foreground cursor-pointer" onClick={() => setExpandedId(open ? null : r.id)}>{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                      <TableCell className="text-sm cursor-pointer" onClick={() => setExpandedId(open ? null : r.id)}>
                        <div className="font-medium">{r.order_no || r.qm_order_no || '—'}</div>
                        {r.internal_no && <div className="text-xs text-muted-foreground">内部单号 {r.internal_no}</div>}
                      </TableCell>
                      <TableCell><Badge variant="secondary" className={`${sev.cls} gap-1`}>{sev.icon}{sev.label}</Badge></TableCell>
                      <TableCell className="text-sm max-w-[16rem]"><span className="line-clamp-2">{r.reason}</span></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.requested_by_name || '—'}<span className="text-[10px] ml-1">({SRC[r.source] || r.source})</span></TableCell>
                      <TableCell className="text-center whitespace-nowrap" onClick={e => e.stopPropagation()}>
                        {selfOwn(r) ? <span className="text-[11px] text-muted-foreground">不能审自己的</span>
                          : (canApproveVoid || canReject) ? (
                            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openDecide(r)}>终审</Button>
                          ) : <span className="text-[11px] text-muted-foreground">待财务</span>}
                      </TableCell>
                    </TableRow>
                    {open && (
                      <TableRow className="bg-muted/20">
                        <TableCell colSpan={6} className="px-4 py-3">
                          <p className="text-xs font-semibold text-muted-foreground mb-2">体检明细 · 作废将牵连:</p>
                          <div className="rounded-md border divide-y bg-background">
                            {items.length === 0 ? <div className="p-2 text-xs text-muted-foreground">无关联数据。</div>
                              : items.map((it, i) => (
                                <div key={i} className="flex items-center gap-3 px-3 py-1.5">
                                  <span className={`h-2 w-2 rounded-full shrink-0 ${DOT[it.level]}`} />
                                  <span className="text-sm font-medium w-44 shrink-0">{it.label}</span>
                                  <Badge variant="secondary" className="text-[10px]">{it.count}</Badge>
                                  <span className="text-xs text-muted-foreground truncate">{it.detail}</span>
                                </div>
                              ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        )}

        {/* 已作废(可恢复)—— 管理员 */}
        {isAdmin && voided.length > 0 && (
          <div className="border-t mt-1 pt-2">
            <p className="px-4 py-1 text-xs font-semibold text-muted-foreground">已作废(近 20 · 管理员可恢复)</p>
            <Table>
              <TableBody>
                {voided.map(r => (
                  <TableRow key={r.id} className="hover:bg-muted/30">
                    <TableCell className="text-sm w-8"></TableCell>
                    <TableCell className="text-sm"><span className="font-medium">{r.order_no || r.qm_order_no || '—'}</span>{r.internal_no && <span className="text-xs text-muted-foreground ml-2">{r.internal_no}</span>}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.decider_name || '—'} · {fmt(r.decided_at)}</TableCell>
                    <TableCell className="text-center">
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-primary" disabled={busy === 'restore'} onClick={() => restore(r)}>
                        <RotateCcw className="h-3.5 w-3.5 mr-1" />恢复
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* 终审弹窗 */}
      <Dialog open={!!sel} onOpenChange={o => !o && !busy && setSel(null)}>
        <DialogContent className="max-w-lg">
          {sel && (() => {
            const sev = SEV[sel.severity]
            const items = (sel.blockers || []).filter(i => i.count > 0)
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    作废终审 <span className="text-sm font-normal text-muted-foreground">{sel.order_no || sel.qm_order_no}</span>
                    <Badge variant="secondary" className={`${sev.cls} gap-1`}>{sev.icon}{sev.label}</Badge>
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div className="rounded-lg border p-3 text-sm space-y-1">
                    <div className="flex justify-between gap-2"><span className="text-muted-foreground">发起</span><span>{sel.requested_by_name}({SRC[sel.source] || sel.source})</span></div>
                    <div className="flex justify-between gap-2"><span className="text-muted-foreground">原因</span><span className="text-right">{sel.reason}</span></div>
                  </div>
                  <div className="rounded-md border divide-y max-h-[32vh] overflow-auto">
                    {items.map((it, i) => (
                      <div key={i} className="flex items-center gap-3 px-3 py-1.5">
                        <span className={`h-2 w-2 rounded-full shrink-0 ${DOT[it.level]}`} />
                        <span className="text-sm font-medium w-44 shrink-0">{it.label}</span>
                        <Badge variant="secondary" className="text-[10px]">{it.count}</Badge>
                        <span className="text-xs text-muted-foreground truncate">{it.detail}</span>
                      </div>
                    ))}
                  </div>
                  {sel.severity === 'blocked_admin' && (
                    <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                      含 🔴 已付款/已收款/已下采购。{isAdmin ? '请确认相关款项已红冲后勾选强制作废。' : '仅管理员可强制作废,请联系管理员。'}
                      {isAdmin && (
                        <label className="flex items-center gap-2 mt-2 cursor-pointer">
                          <Checkbox checked={force} onCheckedChange={v => setForce(v === true)} />
                          <span>我已确认相关款项已红冲,强制作废</span>
                        </label>
                      )}
                    </div>
                  )}
                  <Textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="终审意见(驳回必填)" />
                  <p className="text-[11px] text-muted-foreground">批准即级联软删(可恢复);订单及子数据标记 deleted,不物理删除。</p>
                </div>
                <DialogFooter className="gap-2">
                  {canReject && (
                    <Button variant="destructive" disabled={!!busy} onClick={() => decide('rejected')}>
                      {busy === 'rejected' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <XCircle className="h-4 w-4 mr-1" />}驳回
                    </Button>
                  )}
                  <Button
                    disabled={!!busy || !canApproveVoid || (sel.severity === 'blocked_admin' && (!isAdmin || !force))}
                    onClick={() => decide('approved')}>
                    {busy === 'approved' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                    批准作废
                  </Button>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
