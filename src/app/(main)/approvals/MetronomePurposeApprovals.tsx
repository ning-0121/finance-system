'use client'

// ============================================================
// 节拍器「订单用途变更」待审批(自产/经销/委托)。
// 数据在节拍器侧(order_purpose_change_requests),经签名 GET 拉取;
// 财务批/驳 → POST /api/integration/purpose-requests → 回传节拍器执行(改用途+重算里程碑)。
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { CheckCircle, XCircle, Loader2, Inbox } from 'lucide-react'
import { toast } from 'sonner'

interface PurposeRequest {
  id: string
  order_id: string
  order_no: string | null
  internal_order_no: string | null
  customer_name: string | null
  from_purpose: string
  to_purpose: string
  reason: string | null
  requester_name: string | null
  created_at: string
}

const PURPOSE_LABEL: Record<string, string> = {
  production: '自产(标准生产)',
  trade: '经销 / 采购成品',
  consign: '委托加工 / 外发',
}
const pLabel = (v: string) => PURPOSE_LABEL[v] || v

function fmtDate(v: string): string {
  try { const d = new Date(v); return isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN', { hour12: false }) } catch { return v }
}

export function MetronomePurposeApprovals() {
  const [rows, setRows] = useState<PurposeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [sel, setSel] = useState<PurposeRequest | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setLoadError('')
    try {
      const res = await fetch('/api/integration/purpose-requests')
      const json = await res.json()
      if (!res.ok) { setLoadError(json.error || `HTTP ${res.status}`); setRows([]) }
      else setRows((json.data as PurposeRequest[]) || [])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '加载失败'); setRows([])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const decide = async (action: 'approved' | 'rejected') => {
    if (!sel) return
    if (action === 'rejected' && !note.trim()) { toast.error('驳回请填写原因'); return }
    setBusy(action)
    try {
      const res = await fetch('/api/integration/purpose-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approval_id: sel.id, decision: action, decision_note: note.trim() || null }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || `HTTP ${res.status}`); setBusy(null); return }
      toast.success(`已${action === 'approved' ? '批准并通知节拍器执行' : '驳回'}`)
      setSel(null); setNote('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally { setBusy(null) }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          🏭 节拍器·订单用途待审批
          {rows.length > 0 && <Badge className="bg-amber-100 text-amber-700">{rows.length}</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">业务执行申请把订单改为 经销/委托/自产 —— 批准后节拍器自动改用途并重算里程碑(经销/委托不再核料)。</p>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : loadError ? (
          <div className="text-center py-10 text-sm text-red-600">
            拉取节拍器申请失败:{loadError}
            <div><Button variant="outline" size="sm" className="mt-2" onClick={load}>重试</Button></div>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Inbox className="h-10 w-10 mx-auto mb-2 opacity-30" /><p className="text-sm">暂无待审批的改用途申请</p>
          </div>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>订单</TableHead>
              <TableHead>用途变更</TableHead>
              <TableHead>申请人</TableHead>
              <TableHead className="text-center">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.id} className="cursor-pointer hover:bg-muted/40" onClick={() => { setSel(r); setNote('') }}>
                  <TableCell className="text-sm">
                    <div className="font-medium">{r.internal_order_no || r.order_no || '—'}</div>
                    <div className="text-xs text-muted-foreground">{r.order_no}{r.customer_name ? ` · ${r.customer_name}` : ''}</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="text-muted-foreground">{pLabel(r.from_purpose)}</span>
                    <span className="mx-1">→</span>
                    <span className="font-medium text-amber-700">{pLabel(r.to_purpose)}</span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.requester_name || '业务'}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-center">
                      <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); setSel(r); setNote('') }}>查看并审批</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!sel} onOpenChange={o => !o && !busy && setSel(null)}>
        <DialogContent className="max-w-md">
          {sel && (
            <>
              <DialogHeader><DialogTitle>订单用途变更审批</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="rounded-lg border p-3 text-sm space-y-1.5">
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground">订单</span><span className="font-medium">{sel.internal_order_no || sel.order_no}</span></div>
                  {sel.order_no && <div className="flex justify-between gap-2"><span className="text-muted-foreground">订单号</span><span>{sel.order_no}</span></div>}
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground">客户</span><span>{sel.customer_name || '—'}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground">申请人</span><span>{sel.requester_name || '业务'}</span></div>
                  <div className="flex justify-between gap-2"><span className="text-muted-foreground">提交时间</span><span>{fmtDate(sel.created_at)}</span></div>
                </div>
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
                  <div><b>{pLabel(sel.from_purpose)}</b> → <b className="text-amber-800">{pLabel(sel.to_purpose)}</b></div>
                  {sel.reason && <div className="mt-1 text-xs text-muted-foreground">原因:{sel.reason}</div>}
                </div>
                <p className="text-[11px] text-muted-foreground">批准 → 节拍器执行:改订单用途 + 按新用途重算里程碑(已完成保留、未完成的多余节点移除;经销/委托砍掉采购核料)。</p>
                <Textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="审批意见(驳回必填,回传节拍器给申请人)" />
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
