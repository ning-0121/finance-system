'use client'

// ============================================================
// 集成审批队列(来自节拍器):price/delay/cancel/milestone 审批请求。
// 此前只入 pending_approvals 表却无 UI 可决策 → 死信队列(审计#8)。
// 批/驳 → POST /api/integration/approve(更新本地+回传节拍器 approval_type)。
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
import { createClient } from '@/lib/supabase/client'

interface PendingApproval {
  id: string
  approval_type: 'price' | 'delay' | 'cancel' | 'milestone'
  order_no: string
  customer_name: string | null
  requested_by_name: string | null
  summary: string
  detail: Record<string, unknown>
  created_at: string
  source_created_at: string | null
}

const TYPE_LABEL: Record<string, { label: string; color: string }> = {
  price: { label: '价格审批', color: 'bg-purple-100 text-purple-700' },
  delay: { label: '延期审批', color: 'bg-amber-100 text-amber-700' },
  cancel: { label: '取消订单', color: 'bg-red-100 text-red-700' },
  milestone: { label: '里程碑确认', color: 'bg-blue-100 text-blue-700' },
}

export function IntegrationApprovals({ userId, userName }: { userId: string; userName: string }) {
  const [rows, setRows] = useState<PendingApproval[]>([])
  const [loading, setLoading] = useState(true)
  const [dlg, setDlg] = useState<{ row: PendingApproval; action: 'approved' | 'rejected' } | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const sb = createClient()
    const { data } = await sb.from('pending_approvals')
      .select('id, approval_type, order_no, customer_name, requested_by_name, summary, detail, created_at, source_created_at')
      .eq('status', 'pending').order('created_at', { ascending: true })
    setRows((data as PendingApproval[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const decide = async () => {
    if (!dlg) return
    if (dlg.action === 'rejected' && !note.trim()) { toast.error('驳回请填写原因'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/integration/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approval_id: dlg.row.id,
          approval_type: dlg.row.approval_type,
          decision: dlg.action,
          decided_by: userId,
          decider_name: userName,
          decision_note: note.trim() || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || `HTTP ${res.status}`); setBusy(false); return }
      toast[json.callback_sent ? 'success' : 'warning'](
        `已${dlg.action === 'approved' ? '批准' : '驳回'}` + (json.callback_sent ? '，已通知节拍器' : '，但回传节拍器失败(已入 outbox 重试)')
      )
      setDlg(null); setNote('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          集成审批（来自节拍器）
          {rows.length > 0 && <Badge className="bg-amber-100 text-amber-700">{rows.length}</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">价格 / 延期 / 取消订单 / 里程碑 —— 财务批/驳后自动回传节拍器执行。</p>
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
                <TableRow key={r.id}>
                  <TableCell><Badge className={TYPE_LABEL[r.approval_type]?.color} variant="secondary">{TYPE_LABEL[r.approval_type]?.label || r.approval_type}</Badge></TableCell>
                  <TableCell className="text-sm">
                    <div className="font-medium">{r.order_no}</div>
                    <div className="text-xs text-muted-foreground">{r.customer_name || ''}</div>
                  </TableCell>
                  <TableCell className="text-sm max-w-xs"><span className="line-clamp-2">{r.summary}</span></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.requested_by_name || '-'}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-center gap-1">
                      <Button size="sm" onClick={() => { setDlg({ row: r, action: 'approved' }); setNote('') }}><CheckCircle className="h-3.5 w-3.5 mr-1" />批准</Button>
                      <Button size="sm" variant="destructive" onClick={() => { setDlg({ row: r, action: 'rejected' }); setNote('') }}><XCircle className="h-3.5 w-3.5 mr-1" />驳回</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!dlg} onOpenChange={o => !o && setDlg(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{dlg?.action === 'approved' ? '批准' : '驳回'} · {dlg && TYPE_LABEL[dlg.row.approval_type]?.label}</DialogTitle></DialogHeader>
          {dlg && (
            <div className="space-y-3">
              <div className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
                <div><span className="text-muted-foreground">订单：</span>{dlg.row.order_no} {dlg.row.customer_name || ''}</div>
                <div><span className="text-muted-foreground">摘要：</span>{dlg.row.summary}</div>
              </div>
              <Textarea rows={3} value={note} onChange={e => setNote(e.target.value)}
                placeholder={dlg.action === 'rejected' ? '驳回原因（回传节拍器给申请人）' : '审批意见（可选）'} />
              <p className="text-[11px] text-muted-foreground">结果会回传节拍器：批准→节拍器执行；驳回→拦下并显示原因。</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDlg(null)}>取消</Button>
            <Button onClick={decide} disabled={busy} variant={dlg?.action === 'rejected' ? 'destructive' : 'default'}>
              {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
              确认{dlg?.action === 'approved' ? '批准' : '驳回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
