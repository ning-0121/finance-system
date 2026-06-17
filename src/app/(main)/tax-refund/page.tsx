'use client'

// ============================================================
// 出口退税台账 — 外贸企业免退税：应退/已退/未退跟踪 + 申报到账闭环
// 应退税额 = 采购增值税专票不含税额 × 退税率（自动算，可手工改）。
// ============================================================
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Plus, Pencil, Trash2, FileCheck, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { bizToday } from '@/lib/biz-date'
import { getTaxRefunds, saveTaxRefund, deleteTaxRefund, computeRefundable, type TaxRefund } from '@/lib/supabase/tax-refund'

const fmt = (n: number) => `¥${Math.round(n).toLocaleString()}`
const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: '待申报', cls: 'bg-blue-100 text-blue-700' },
  declared: { label: '已申报', cls: 'bg-amber-100 text-amber-700' },
  refunded: { label: '已退税', cls: 'bg-green-100 text-green-700' },
}
type Form = Partial<TaxRefund>

export default function TaxRefundPage() {
  const [rows, setRows] = useState<TaxRefund[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'all' | 'pending' | 'declared' | 'refunded'>('all')
  const [dialog, setDialog] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [recvDialog, setRecvDialog] = useState<TaxRefund | null>(null)
  const [recvAmount, setRecvAmount] = useState('')
  const [recvDate, setRecvDate] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try { setRows(await getTaxRefunds()) }
    catch (e) { toast.error(`加载失败：${e instanceof Error ? e.message : '未知'}（若提示表不存在，请先执行迁移 20260613_tax_refunds.sql）`) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const stats = useMemo(() => {
    const refundable = rows.filter(r => r.status !== 'refunded').reduce((s, r) => s + Number(r.refundable_amount), 0)
    const refunded = rows.filter(r => r.status === 'refunded').reduce((s, r) => s + (Number(r.refund_received_amount) || 0), 0)
    const declaredNotRecv = rows.filter(r => r.status === 'declared').reduce((s, r) => s + Number(r.refundable_amount), 0)
    const docIncomplete = rows.filter(r => r.status === 'pending' && !(r.doc_customs && r.doc_invoice && r.doc_forex)).length
    return { refundable, refunded, declaredNotRecv, docIncomplete }
  }, [rows])

  const filtered = tab === 'all' ? rows : rows.filter(r => r.status === tab)

  const openNew = () => setDialog({ export_date: bizToday(), refund_rate: 13, status: 'pending', input_invoice_amount: 0, doc_customs: false, doc_invoice: false, doc_forex: false })
  const openEdit = (r: TaxRefund) => setDialog({ ...r })

  const save = async () => {
    if (!dialog) return
    setSaving(true)
    try {
      const refundable = dialog.refundable_amount && dialog.refundable_amount > 0
        ? dialog.refundable_amount
        : computeRefundable(dialog.input_invoice_amount || 0, dialog.refund_rate || 13)
      const fobCny = dialog.fob_usd && dialog.exchange_rate ? Math.round(dialog.fob_usd * dialog.exchange_rate * 100) / 100 : (dialog.fob_cny ?? null)
      const { error } = await saveTaxRefund({ ...dialog, refundable_amount: refundable, fob_cny: fobCny })
      if (error) throw new Error(error)
      toast.success('已保存')
      setDialog(null); await load()
    } catch (e) { toast.error(`保存失败：${e instanceof Error ? e.message : '未知'}`) }
    finally { setSaving(false) }
  }

  const markDeclared = async (r: TaxRefund) => {
    if (!(r.doc_customs && r.doc_invoice && r.doc_forex) && !confirm('单证尚不齐全（报关单/专票/收汇），确认仍标记为已申报？')) return
    const { error } = await saveTaxRefund({ id: r.id, status: 'declared', declared_at: bizToday() })
    if (error) { toast.error(error); return }
    toast.success('已标记申报'); await load()
  }
  const markRefunded = async () => {
    if (!recvDialog) return
    const amt = Number(recvAmount)
    if (!amt || amt <= 0) { toast.error('请输入实退金额'); return }
    const { error } = await saveTaxRefund({ id: recvDialog.id, status: 'refunded', refund_received_amount: amt, refund_received_at: recvDate || bizToday() })
    if (error) { toast.error(error); return }
    toast.success('已标记退税到账'); setRecvDialog(null); setRecvAmount(''); setRecvDate(''); await load()
  }
  const del = async (r: TaxRefund) => {
    if (!confirm(`删除报关单 ${r.customs_no || ''} 的退税记录？`)) return
    const { error } = await deleteTaxRefund(r.id)
    if (error) { toast.error(error); return }
    toast.success('已删除'); await load()
  }

  const autoRefundable = computeRefundable(dialog?.input_invoice_amount || 0, dialog?.refund_rate || 13)

  return (
    <div className="flex flex-col h-full">
      <Header title="出口退税" subtitle="退税台账 · 应退/已退/未退跟踪 · 申报到账闭环" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">应退税额（未到账）</p><p className="text-2xl font-bold text-amber-600">{fmt(stats.refundable)}</p></CardContent></Card>
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">已退税到账</p><p className="text-2xl font-bold text-green-600">{fmt(stats.refunded)}</p></CardContent></Card>
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">已申报待到账</p><p className="text-2xl font-bold text-blue-600">{fmt(stats.declaredNotRecv)}</p></CardContent></Card>
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">单证不齐</p><p className="text-2xl font-bold text-red-600">{stats.docIncomplete}</p></CardContent></Card>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="all">全部 ({rows.length})</TabsTrigger>
              <TabsTrigger value="pending">待申报 ({rows.filter(r => r.status === 'pending').length})</TabsTrigger>
              <TabsTrigger value="declared">已申报 ({rows.filter(r => r.status === 'declared').length})</TabsTrigger>
              <TabsTrigger value="refunded">已退税 ({rows.filter(r => r.status === 'refunded').length})</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button size="sm" onClick={openNew}><Plus className="h-4 w-4 mr-1" />新增退税单</Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <Card>
            <Table>
              <TableHeader><TableRow>
                <TableHead>报关单号</TableHead><TableHead>品名</TableHead><TableHead>出口日期</TableHead>
                <TableHead className="text-right">FOB(USD)</TableHead><TableHead className="text-right">进项不含税</TableHead>
                <TableHead className="text-right">退税率</TableHead><TableHead className="text-right">应退税额</TableHead>
                <TableHead>单证</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {filtered.map(r => {
                  const docs = [r.doc_customs && '报', r.doc_invoice && '票', r.doc_forex && '汇'].filter(Boolean)
                  const full = r.doc_customs && r.doc_invoice && r.doc_forex
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm">{r.customs_no || '—'}</TableCell>
                      <TableCell className="text-sm">{r.product_name || '—'}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{r.export_date || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{r.fob_usd ? `$${r.fob_usd.toLocaleString()}` : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{fmt(r.input_invoice_amount)}</TableCell>
                      <TableCell className="text-right tabular-nums text-sm">{r.refund_rate}%</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{fmt(r.refundable_amount)}{r.status === 'refunded' && r.refund_received_amount != null && Math.abs(r.refund_received_amount - r.refundable_amount) > 0.5 && <span className="block text-[10px] text-muted-foreground">实退 {fmt(r.refund_received_amount)}</span>}</TableCell>
                      <TableCell><span className={`text-xs ${full ? 'text-green-600' : 'text-red-500'}`}>{full ? '齐全' : (docs.join('') || '缺')}</span></TableCell>
                      <TableCell><Badge className={STATUS[r.status].cls}>{STATUS[r.status].label}</Badge></TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        {r.status === 'pending' && <Button size="sm" variant="outline" className="h-7" onClick={() => markDeclared(r)}><FileCheck className="h-3 w-3 mr-1" />申报</Button>}
                        {r.status === 'declared' && <Button size="sm" variant="outline" className="h-7" onClick={() => { setRecvDialog(r); setRecvAmount(String(r.refundable_amount)); setRecvDate(bizToday()) }}><CheckCircle2 className="h-3 w-3 mr-1" />到账</Button>}
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500" onClick={() => del(r)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {filtered.length === 0 && <TableRow><TableCell colSpan={10} className="text-center py-10 text-muted-foreground">暂无退税记录</TableCell></TableRow>}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      {/* 新增/编辑 */}
      {dialog && (
        <Dialog open onOpenChange={() => setDialog(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>{dialog.id ? '编辑退税单' : '新增退税单'}</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 py-2 max-h-[60vh] overflow-y-auto">
              <div className="space-y-1"><Label className="text-xs">报关单号</Label><Input value={dialog.customs_no || ''} onChange={e => setDialog({ ...dialog, customs_no: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">出口日期</Label><Input type="date" value={dialog.export_date || ''} onChange={e => setDialog({ ...dialog, export_date: e.target.value })} /></div>
              <div className="space-y-1 col-span-2"><Label className="text-xs">品名</Label><Input value={dialog.product_name || ''} onChange={e => setDialog({ ...dialog, product_name: e.target.value })} /></div>
              <div className="space-y-1"><Label className="text-xs">FOB (USD)</Label><Input type="number" value={dialog.fob_usd ?? ''} onChange={e => setDialog({ ...dialog, fob_usd: Number(e.target.value) || 0 })} /></div>
              <div className="space-y-1"><Label className="text-xs">汇率</Label><Input type="number" step="0.0001" value={dialog.exchange_rate ?? ''} onChange={e => setDialog({ ...dialog, exchange_rate: Number(e.target.value) || 0 })} /></div>
              <div className="space-y-1"><Label className="text-xs">进项专票不含税额 *</Label><Input type="number" value={dialog.input_invoice_amount ?? 0} onChange={e => setDialog({ ...dialog, input_invoice_amount: Number(e.target.value) || 0, refundable_amount: 0 })} /></div>
              <div className="space-y-1"><Label className="text-xs">退税率 %</Label><Input type="number" step="0.01" value={dialog.refund_rate ?? 13} onChange={e => setDialog({ ...dialog, refund_rate: Number(e.target.value) || 0, refundable_amount: 0 })} /></div>
              <div className="space-y-1 col-span-2"><Label className="text-xs">应退税额（默认 进项×退税率 = {fmt(autoRefundable)}，可手工改）</Label><Input type="number" value={dialog.refundable_amount || ''} placeholder={String(autoRefundable)} onChange={e => setDialog({ ...dialog, refundable_amount: Number(e.target.value) || 0 })} /></div>
              <div className="col-span-2 flex gap-4 text-sm">
                <label className="flex items-center gap-1"><input type="checkbox" checked={!!dialog.doc_customs} onChange={e => setDialog({ ...dialog, doc_customs: e.target.checked })} />报关单</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={!!dialog.doc_invoice} onChange={e => setDialog({ ...dialog, doc_invoice: e.target.checked })} />增值税专票</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={!!dialog.doc_forex} onChange={e => setDialog({ ...dialog, doc_forex: e.target.checked })} />收汇</label>
              </div>
              <div className="space-y-1 col-span-2"><Label className="text-xs">备注</Label><Input value={dialog.notes || ''} onChange={e => setDialog({ ...dialog, notes: e.target.value })} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)}>取消</Button>
              <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 退税到账 */}
      {recvDialog && (
        <Dialog open onOpenChange={() => setRecvDialog(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader><DialogTitle>退税到账 — {recvDialog.customs_no || ''}</DialogTitle></DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1"><Label className="text-xs">实退金额（应退 {fmt(recvDialog.refundable_amount)}）</Label><Input type="number" value={recvAmount} onChange={e => setRecvAmount(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">到账日期</Label><Input type="date" value={recvDate} onChange={e => setRecvDate(e.target.value)} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRecvDialog(null)}>取消</Button>
              <Button onClick={markRefunded}>确认到账</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
