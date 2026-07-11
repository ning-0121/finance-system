'use client'

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Plus, CalendarClock, CheckCircle, Banknote, Trash2, ShieldCheck, X, Send, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import {
  getPaymentBatches, getBatchLines, getSchedulablePayables, getAppRole,
  createPaymentBatch, addBatchLine, removeBatchLine, submitBatch, approveBatch,
  executeBatchLine, closeBatch, cancelBatch,
  type PaymentBatch, type PaymentBatchLine, type SchedulablePayable, type BatchStatus,
} from '@/lib/supabase/payment-batches'

const STATUS: Record<BatchStatus, { label: string; color: string }> = {
  draft: { label: '草稿(排款中)', color: 'bg-gray-100 text-gray-700' },
  submitted: { label: '待老板审批', color: 'bg-amber-100 text-amber-700' },
  approved: { label: '已批·待放款', color: 'bg-purple-100 text-purple-700' },
  executing: { label: '放款中', color: 'bg-blue-100 text-blue-700' },
  closed: { label: '已完成', color: 'bg-green-100 text-green-700' },
  cancelled: { label: '已作废', color: 'bg-gray-100 text-gray-400' },
}
const LINE_STATUS: Record<string, { label: string; color: string }> = {
  planned: { label: '待付', color: 'bg-amber-100 text-amber-700' },
  paid: { label: '已付', color: 'bg-green-100 text-green-700' },
  skipped: { label: '未付(移出)', color: 'bg-gray-100 text-gray-500' },
  held: { label: '挂起', color: 'bg-orange-100 text-orange-700' },
}
const fmt = (n: number, ccy: string) =>
  `${ccy === 'USD' ? '$' : '¥'}${Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDate = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : '-')
const today = () => new Date().toISOString().slice(0, 10)

export default function PaymentBatchesPage() {
  const [batches, setBatches] = useState<PaymentBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [role, setRole] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [lines, setLines] = useState<PaymentBatchLine[]>([])
  const [busy, setBusy] = useState(false)

  // 建单
  const [createOpen, setCreateOpen] = useState(false)
  const [ccy, setCcy] = useState('CNY')
  const [payDate, setPayDate] = useState(today())
  const [title, setTitle] = useState('')

  // 加应付
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickables, setPickables] = useState<SchedulablePayable[]>([])
  const [pickAmt, setPickAmt] = useState<Record<string, string>>({})
  const [pickLoading, setPickLoading] = useState(false)

  // 执行付款
  const [execLine, setExecLine] = useState<PaymentBatchLine | null>(null)
  const [execRef, setExecRef] = useState('')
  const [execDate, setExecDate] = useState(today())
  const [execNote, setExecNote] = useState('')

  const selected = batches.find(b => b.id === selectedId) || null
  const canApprove = !role || ['finance_manager', 'admin', 'boss', 'owner'].includes(role)

  const loadBatches = useCallback(async () => {
    setLoading(true)
    const list = await getPaymentBatches()
    setBatches(list)
    setSelectedId(prev => prev && list.some(b => b.id === prev) ? prev : (list[0]?.id || null))
    setLoading(false)
  }, [])

  const loadLines = useCallback(async (id: string) => {
    setLines(await getBatchLines(id))
  }, [])

  useEffect(() => { loadBatches(); getAppRole().then(setRole) }, [loadBatches])
  useEffect(() => { if (selectedId) loadLines(selectedId); else setLines([]) }, [selectedId, loadLines])

  const refresh = async () => { await loadBatches(); if (selectedId) await loadLines(selectedId) }

  // ── 建单 ──
  const doCreate = async () => {
    setBusy(true)
    const { data, error } = await createPaymentBatch({ currency: ccy, planned_pay_date: payDate || null, title: title.trim() || null })
    setBusy(false)
    if (error) return toast.error(error)
    toast.success(`已建排款单 ${data?.batch_no}`)
    setCreateOpen(false); setTitle('')
    await loadBatches()
    if (data?.id) setSelectedId(data.id as string)
  }

  // ── 加应付：打开选择器 ──
  const openPicker = async () => {
    if (!selected) return
    setPickerOpen(true); setPickLoading(true)
    const list = await getSchedulablePayables(selected.currency)
    // 已在本单的应付去重(避免重复排同一笔到同一单)
    const inBatch = new Set(lines.filter(l => l.status !== 'skipped').map(l => l.payable_id))
    setPickables(list.filter(p => !inBatch.has(p.id)))
    setPickAmt({}); setPickLoading(false)
  }
  const addOne = async (p: SchedulablePayable) => {
    if (!selected) return
    const raw = pickAmt[p.id]
    const amt = raw ? Number(raw) : p.remaining
    if (amt <= 0 || amt > p.remaining + 0.005) return toast.error(`金额须在 0 ~ ${fmt(p.remaining, selected.currency)} 之间`)
    setBusy(true)
    const { error } = await addBatchLine(selected.id, p.id, amt)
    setBusy(false)
    if (error) return toast.error(error)
    toast.success('已加入排款单')
    await loadLines(selected.id); await loadBatches()
    setPickables(prev => prev.filter(x => x.id !== p.id))
  }

  const doRemoveLine = async (l: PaymentBatchLine) => {
    if (!confirm(`移出 ${l.supplier_name} ${fmt(l.pay_amount, l.currency)}？`)) return
    setBusy(true); const { error } = await removeBatchLine(l.id); setBusy(false)
    if (error) return toast.error(error)
    toast.success('已移出'); await refresh()
  }

  const doSubmit = async () => {
    if (!selected) return
    setBusy(true); const { error } = await submitBatch(selected.id); setBusy(false)
    if (error) return toast.error(error)
    toast.success('已提交，等待老板审批'); await refresh()
  }
  const doApprove = async () => {
    if (!selected) return
    if (!confirm(`审批放款：${selected.batch_no}，共 ${fmt(selected.total_amount, selected.currency)}？`)) return
    setBusy(true); const { error } = await approveBatch(selected.id); setBusy(false)
    if (error) return toast.error(error)
    toast.success('已审批，出纳可放款'); await refresh()
  }
  const doClose = async () => {
    if (!selected || !confirm('关单？未付的行将标记为「未付」，剩余应付下周可再排。')) return
    setBusy(true); const { error } = await closeBatch(selected.id); setBusy(false)
    if (error) return toast.error(error)
    toast.success('已关单'); await refresh()
  }
  const doCancel = async () => {
    if (!selected) return
    const reason = prompt('作废原因？')
    if (reason === null) return
    setBusy(true); const { error } = await cancelBatch(selected.id, reason || undefined); setBusy(false)
    if (error) return toast.error(error)
    toast.success('已作废'); await refresh()
  }

  // ── 执行付款 ──
  const openExec = (l: PaymentBatchLine) => { setExecLine(l); setExecRef(''); setExecDate(today()); setExecNote('') }
  const doExec = async () => {
    if (!execLine) return
    if (!execRef.trim() && !confirm('未填付款凭证号(银行流水/回单号)。凭证号是防重复付款最硬的一道锁，确定不填就付款？')) return
    setBusy(true)
    const { error } = await executeBatchLine(execLine.id, { payment_ref: execRef.trim(), paid_at: execDate || null, note: execNote.trim() || null })
    setBusy(false)
    if (error) return toast.error(error)
    toast.success('付款已登记，应付已核销')
    // 往返:付款完成 → 回传节拍器(让采购/订单部门看到"付款完成"进度)。best-effort,失败自动入 outbox。
    try {
      const sb = createClient()
      const { data: pay } = await sb.from('payable_records').select('order_no, budget_order_id').eq('id', execLine.payable_id).maybeSingle()
      let qimo: string | null = null
      const boId = (pay as { budget_order_id?: string } | null)?.budget_order_id
      if (boId) {
        const { data: so } = await sb.from('synced_orders').select('id').eq('budget_order_id', boId).maybeSingle()
        qimo = (so as { id?: string } | null)?.id || null
      }
      void fetch('/api/integration/finance-progress', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        keepalive: true,   // E-2:关页/跳转后仍发出,付款进度回传不丢(到路由即入 outbox)
        body: JSON.stringify({ event: 'payment.completed', qimo_order_id: qimo, order_no: (pay as { order_no?: string } | null)?.order_no || null, amount: execLine.pay_amount, currency: execLine.currency, note: `供应商 ${execLine.supplier_name} 付款完成` }),
      }).catch(() => {})
    } catch { /* 进度回传不阻断付款 */ }
    setExecLine(null); await refresh()
  }

  const plannedLines = lines.filter(l => l.status === 'planned')

  return (
    <div className="flex flex-col h-full">
      <Header title="周排款（付款执行）" subtitle="应付 → 周排款单 → 老板审批 → 出纳放款 → 自动核销 · 结构性防重复付款" />
      <div className="flex-1 overflow-auto p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            每周把要付的应付排进单子，老板一次审批，出纳逐笔放款并录凭证号。同一笔应付不会被重复排、重复付。
          </p>
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4 mr-1" />新建排款单</Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
          {/* 左：排款单列表 */}
          <Card>
            <CardContent className="p-2 space-y-1 max-h-[75vh] overflow-auto">
              {loading ? (
                <div className="p-6 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
              ) : batches.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">还没有排款单，点右上「新建排款单」开始。</div>
              ) : batches.map(b => (
                <button key={b.id} onClick={() => setSelectedId(b.id)}
                  className={`w-full text-left rounded-lg border p-3 transition ${selectedId === b.id ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted/50'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold">{b.batch_no}</span>
                    <Badge className={STATUS[b.status].color} variant="secondary">{STATUS[b.status].label}</Badge>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{b.week_label} · {b.currency}</span>
                    <span className="font-semibold text-foreground">{fmt(b.total_amount, b.currency)}</span>
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>

          {/* 右：单据详情 */}
          {!selected ? (
            <Card><CardContent className="p-10 text-center text-muted-foreground">选择左侧一张排款单查看明细</CardContent></Card>
          ) : (
            <Card>
              <CardContent className="p-4 space-y-4">
                {/* 头 */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold">{selected.batch_no}</span>
                      <Badge className={STATUS[selected.status].color} variant="secondary">{STATUS[selected.status].label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {selected.week_label} · 币种 {selected.currency} · 计划放款 {fmtDate(selected.planned_pay_date)}
                      {selected.title ? ` · ${selected.title}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold">{fmt(selected.total_amount, selected.currency)}</div>
                    <div className="text-xs text-muted-foreground">已付 {fmt(selected.paid_total, selected.currency)}</div>
                  </div>
                </div>

                {/* 操作条 */}
                <div className="flex flex-wrap gap-2">
                  {selected.status === 'draft' && (
                    <>
                      <Button size="sm" variant="outline" onClick={openPicker}><Plus className="h-4 w-4 mr-1" />加应付</Button>
                      <Button size="sm" onClick={doSubmit} disabled={busy || plannedLines.length === 0}><Send className="h-4 w-4 mr-1" />提交审批</Button>
                      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={doCancel} disabled={busy}>作废</Button>
                    </>
                  )}
                  {selected.status === 'submitted' && (
                    canApprove
                      ? <>
                          <Button size="sm" onClick={doApprove} disabled={busy}><ShieldCheck className="h-4 w-4 mr-1" />审批放款（老板）</Button>
                          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={doCancel} disabled={busy}>退回作废</Button>
                        </>
                      : <span className="text-sm text-amber-600 flex items-center"><Lock className="h-4 w-4 mr-1" />等待老板审批放款</span>
                  )}
                  {(selected.status === 'approved' || selected.status === 'executing') && (
                    <>
                      <span className="text-sm text-purple-600 flex items-center"><Banknote className="h-4 w-4 mr-1" />出纳逐笔放款，录付款凭证号</span>
                      <Button size="sm" variant="outline" onClick={doClose} disabled={busy}>关单收尾</Button>
                    </>
                  )}
                </div>

                {/* 明细 */}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>供应商</TableHead>
                      <TableHead>收款信息</TableHead>
                      <TableHead className="text-right">本次付款</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>凭证号 / 操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">还没有明细，点「加应付」把本周要付的应付排进来</TableCell></TableRow>
                    ) : lines.map(l => (
                      <TableRow key={l.id}>
                        <TableCell className="font-medium">{l.supplier_name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {l.payee_name || '-'}{l.payee_account ? ` · ${l.payee_account}` : ''}{l.payee_bank ? ` · ${l.payee_bank}` : ''}
                        </TableCell>
                        <TableCell className="text-right font-semibold">{fmt(l.pay_amount, l.currency)}</TableCell>
                        <TableCell><Badge className={LINE_STATUS[l.status]?.color} variant="secondary">{LINE_STATUS[l.status]?.label}</Badge></TableCell>
                        <TableCell>
                          {l.status === 'paid' ? (
                            <span className="text-xs text-muted-foreground">{l.payment_ref || '—'} · {fmtDate(l.executed_at)}</span>
                          ) : l.status === 'planned' && selected.status === 'draft' ? (
                            <Button size="sm" variant="ghost" className="text-destructive h-7 px-2" onClick={() => doRemoveLine(l)}><Trash2 className="h-3.5 w-3.5" /></Button>
                          ) : l.status === 'planned' && (selected.status === 'approved' || selected.status === 'executing') ? (
                            <Button size="sm" className="h-7" onClick={() => openExec(l)}><Banknote className="h-3.5 w-3.5 mr-1" />放款</Button>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* 建单 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>新建周排款单</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>币种（单一币种）</Label>
                <Select value={ccy} onValueChange={v => v && setCcy(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CNY">CNY 人民币</SelectItem>
                    <SelectItem value="USD">USD 美元</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>计划放款日</Label>
                <Input type="date" value={payDate} onChange={e => setPayDate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>备注标题（可选）</Label>
              <Input placeholder="如「第28周排款」" value={title} onChange={e => setTitle(e.target.value)} />
            </div>
            <p className="text-[11px] text-muted-foreground">USD 与 CNY 各建一张。建好后到明细里逐笔「加应付」。</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>取消</Button>
            <Button onClick={doCreate} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CalendarClock className="h-4 w-4 mr-1" />}建单</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 加应付选择器 */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>加应付进 {selected?.batch_no}（{selected?.currency}）</DialogTitle></DialogHeader>
          <div className="max-h-[60vh] overflow-auto">
            {pickLoading ? (
              <div className="p-8 text-center"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></div>
            ) : pickables.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">没有可排的 {selected?.currency} 应付（都已排款/付清，或币种不符）。</div>
            ) : (
              <Table className="w-full table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead>供应商 / 说明</TableHead>
                    <TableHead className="text-right w-24">应付</TableHead>
                    <TableHead className="text-right w-24">剩余可排</TableHead>
                    <TableHead className="w-28">本次付</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pickables.map(p => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium break-all">{p.supplier_name}</div>
                        <div className="text-xs text-muted-foreground break-all">{p.description}{p.order_no ? ` · ${p.order_no}` : ''}{p.due_date ? ` · 到期 ${fmtDate(p.due_date)}` : ''}</div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">{fmt(p.amount, p.currency)}</TableCell>
                      <TableCell className="text-right font-semibold whitespace-nowrap">{fmt(p.remaining, p.currency)}</TableCell>
                      <TableCell>
                        <Input type="number" step="0.01" placeholder={String(p.remaining)} value={pickAmt[p.id] || ''}
                          onChange={e => setPickAmt(m => ({ ...m, [p.id]: e.target.value }))} className="h-8 w-24" />
                      </TableCell>
                      <TableCell>
                        <Button size="sm" className="h-8" disabled={busy} onClick={() => addOne(p)}><Plus className="h-3.5 w-3.5" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <DialogFooter>
            <p className="text-[11px] text-muted-foreground mr-auto">留空「本次付」= 付剩余全部；填小于剩余 = 部分付（定金/尾款），余额下周可再排。</p>
            <Button variant="outline" onClick={() => setPickerOpen(false)}><X className="h-4 w-4 mr-1" />完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 执行付款 */}
      <Dialog open={!!execLine} onOpenChange={o => !o && setExecLine(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>放款 · {execLine?.supplier_name}</DialogTitle></DialogHeader>
          {execLine && (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 p-3 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">本次付款</span><span className="font-bold">{fmt(execLine.pay_amount, execLine.currency)}</span></div>
                <div className="flex justify-between mt-1"><span className="text-muted-foreground">收款</span><span>{execLine.payee_name || '-'}{execLine.payee_account ? ` · ${execLine.payee_account}` : ''}</span></div>
              </div>
              <div className="space-y-2">
                <Label>付款凭证号 / 单据号 <span className="text-[11px] text-muted-foreground">（银行流水号/回单号——防重复付款最硬的锁，强烈建议填）</span></Label>
                <Input placeholder="同供应商同凭证号，数据库层拒绝重复付款" value={execRef} onChange={e => setExecRef(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>付款日期</Label>
                <Input type="date" value={execDate} onChange={e => setExecDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>备注（可选）</Label>
                <Textarea rows={2} value={execNote} onChange={e => setExecNote(e.target.value)} />
              </div>
              <p className="text-[11px] text-muted-foreground">登记后：写入付款流水、核销应付（付清/部分付）、自动同步到供应商对账单——一步到位、不可重复执行。</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setExecLine(null)}>取消</Button>
            <Button onClick={doExec} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}确认放款</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
