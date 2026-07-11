'use client'

// ============================================================
// 订单作废「体检」弹窗(切片1:只读预览)
// 点「申请作废」→ 拉 /api/orders/[id]/void-preflight → 三级展示「删这单会牵连什么」。
// 本步不做任何写:发起作废申请 + 财务终审在切片2/3 上线。
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { Loader2, ShieldAlert, ShieldCheck, AlertTriangle, Ban } from 'lucide-react'

interface VoidItem { table: string; label: string; level: 'green' | 'amber' | 'red'; count: number; detail: string; ids: string[] }
interface VoidPreflight {
  budgetOrderId: string; orderNo: string | null; internalNo: string | null; qmOrderNo: string | null
  items: VoidItem[]; severity: 'clean' | 'has_approved' | 'blocked_admin'; hasApproved: boolean; hasBlocker: boolean
}

const LEVEL_META: Record<VoidItem['level'], { dot: string; text: string; tag: string }> = {
  red: { dot: 'bg-red-500', text: 'text-red-700', tag: '🔴 硬阻断·联系管理员' },
  amber: { dot: 'bg-amber-500', text: 'text-amber-700', tag: '🟡 已审批·需财务确认' },
  green: { dot: 'bg-emerald-500', text: 'text-emerald-700', tag: '🟢 可直接撤' },
}
const ORDER: VoidItem['level'][] = ['red', 'amber', 'green']

export function OrderVoidDialog({ orderId, open, onOpenChange, onSubmitted }: {
  orderId: string; open: boolean; onOpenChange: (o: boolean) => void; onSubmitted?: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<VoidPreflight | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setData(null); setReason('')
    try {
      const res = await fetch(`/api/orders/${orderId}/void-preflight`)
      const json = await res.json()
      if (!res.ok) { setErr(json.error || `HTTP ${res.status}`); return }
      setData(json as VoidPreflight)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '体检失败')
    } finally { setLoading(false) }
  }, [orderId])

  useEffect(() => { if (open) load() }, [open, load])

  const submit = async () => {
    if (reason.trim().length < 4) { toast.error('请填写作废原因(至少 4 字)'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/orders/${orderId}/void-request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      const json = await res.json()
      if (!res.ok) { toast.error(json.error || `HTTP ${res.status}`); return }
      toast.success(json.already ? '该订单已有待审作废申请' : '作废申请已提交,待财务终审')
      onSubmitted?.()
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交失败')
    } finally { setSubmitting(false) }
  }

  const banner = (() => {
    if (!data) return null
    if (data.severity === 'blocked_admin') return { cls: 'bg-red-50 border-red-200 text-red-800', icon: <ShieldAlert className="h-4 w-4" />, title: '含已付款/已收款/已下采购,不能直接作废', desc: '这些是真金白银已动的数据,须先红冲对应款项,或由管理员(admin)处理。' }
    if (data.severity === 'has_approved') return { cls: 'bg-amber-50 border-amber-200 text-amber-800', icon: <AlertTriangle className="h-4 w-4" />, title: '含已审批数据,作废需财务终审', desc: '下方 🟡 项已审批但未动钱,作废申请将提交财务经理逐项确认后才级联撤销。' }
    return { cls: 'bg-emerald-50 border-emerald-200 text-emerald-800', icon: <ShieldCheck className="h-4 w-4" />, title: '全部可撤,作废仍需财务终审', desc: '未见已审批/已动钱数据;作废申请提交财务终审通过后,将级联软删(可恢复)。' }
  })()

  const shown = (data?.items || []).filter(i => i.count > 0).sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            作废体检
            {data && <span className="text-xs font-normal text-muted-foreground">{data.orderNo || ''}{data.internalNo ? ` · 内部单号 ${data.internalNo}` : ''}</span>}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : err ? (
          <div className="p-4 text-sm text-red-600 bg-red-50 rounded-md">体检失败:{err}</div>
        ) : data ? (
          <div className="space-y-3">
            {banner && (
              <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${banner.cls}`}>
                <span className="mt-0.5 shrink-0">{banner.icon}</span>
                <div><p className="font-medium">{banner.title}</p><p className="text-xs mt-0.5 opacity-90">{banner.desc}</p></div>
              </div>
            )}
            <div className="rounded-lg border divide-y max-h-[46vh] overflow-auto">
              {shown.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground text-center">该订单无任何关联数据,可安全作废。</div>
              ) : shown.map((it, i) => {
                const m = LEVEL_META[it.level]
                return (
                  <div key={i} className="flex items-center gap-3 px-3 py-2">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${m.dot}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{it.label}</span>
                        <Badge variant="secondary" className="text-[10px]">{it.count}</Badge>
                      </div>
                      <p className={`text-xs ${m.text} truncate`}>{it.detail}</p>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="space-y-1">
              <Label className="text-xs font-semibold">作废原因(必填)</Label>
              <Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)}
                placeholder="为什么作废这张订单?会记入作废申请、给财务终审参考" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              提交后进入<b>财务作废队列</b>等终审:🟢 随单撤销 · 🟡 财务经理逐项确认 · 🔴 须先红冲或管理员处理。全程软删可恢复,订单在终审通过前不动。
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>关闭</Button>
          <Button variant="destructive" onClick={submit} disabled={submitting || loading || !!err || reason.trim().length < 4}>
            {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Ban className="h-4 w-4 mr-1" />}
            提交作废申请
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
