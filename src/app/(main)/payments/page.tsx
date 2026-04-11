'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { DollarSign, Clock, CheckCircle, AlertTriangle, Loader2, Search, CreditCard } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { getPayableRecords } from '@/lib/supabase/queries-v2'
import type { PayableRecord, PaymentStatus } from '@/lib/types'

const statusConfig: Record<PaymentStatus, { label: string; color: string }> = {
  unpaid: { label: '待审批', color: 'bg-amber-100 text-amber-700' },
  pending_approval: { label: '审批中', color: 'bg-blue-100 text-blue-700' },
  approved: { label: '待付款', color: 'bg-purple-100 text-purple-700' },
  paid: { label: '已付款', color: 'bg-green-100 text-green-700' },
  cancelled: { label: '已取消', color: 'bg-gray-100 text-gray-700' },
}

export default function PaymentsPage() {
  const [records, setRecords] = useState<PayableRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [payDialog, setPayDialog] = useState<PayableRecord | null>(null)
  const [payRef, setPayRef] = useState('')
  const [payNote, setPayNote] = useState('')
  const [processing, setProcessing] = useState(false)

  useEffect(() => {
    async function load() {
      const data = await getPayableRecords()
      setRecords(data)
      setLoading(false)
    }
    load()
  }, [])

  const filtered = records.filter(r => {
    const matchFilter = filter === 'all' || r.payment_status === filter
    const matchSearch = !search || r.supplier_name.toLowerCase().includes(search.toLowerCase()) || (r.order_no || '').toLowerCase().includes(search.toLowerCase())
    return matchFilter && matchSearch
  })

  const totalUnpaid = records.filter(r => r.payment_status !== 'paid' && r.payment_status !== 'cancelled').reduce((s, r) => s + r.amount, 0)
  const totalPaid = records.filter(r => r.payment_status === 'paid').reduce((s, r) => s + (r.paid_amount || r.amount), 0)
  const overBudgetCount = records.filter(r => r.over_budget).length

  const handleApprove = async (id: string) => {
    setProcessing(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from('payable_records').update({ payment_status: 'approved', approved_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
      setRecords(records.map(r => r.id === id ? { ...r, payment_status: 'approved' as PaymentStatus } : r))
      toast.success('已审批通过')
    } catch (err) { toast.error(`审批失败: ${err instanceof Error ? err.message : '未知错误'}`) }
    setProcessing(false)
  }

  const handlePay = async () => {
    if (!payDialog) return
    setProcessing(true)
    try {
      const supabase = createClient()
      const { error } = await supabase.from('payable_records').update({
        payment_status: 'paid', paid_at: new Date().toISOString(),
        paid_amount: payDialog.amount, payment_method: 'bank_transfer',
        payment_reference: payRef || null, notes: payNote || null,
      }).eq('id', payDialog.id)
      if (error) throw error

      if (payDialog.invoice_id) {
        const { error: invoiceErr } = await supabase.from('actual_invoices').update({ status: 'paid' }).eq('id', payDialog.invoice_id)
        if (invoiceErr) console.error('发票状态更新失败:', invoiceErr.message)
      }

      setRecords(records.map(r => r.id === payDialog.id ? { ...r, payment_status: 'paid' as PaymentStatus } : r))
      toast.success('付款完成')
      setPayDialog(null); setPayRef(''); setPayNote('')
    } catch (err) { toast.error(`付款失败: ${err instanceof Error ? err.message : '未知错误'}`) }
    setProcessing(false)
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="付款审批与出纳" subtitle="应付从决算中自动产生 · 审批→付款→回写发票状态" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-amber-50"><DollarSign className="h-4 w-4 text-amber-600" /></div><div><p className="text-xs text-muted-foreground">待付总额</p><p className="text-xl font-bold text-amber-600">${totalUnpaid.toLocaleString()}</p></div></CardContent></Card>
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-green-50"><CheckCircle className="h-4 w-4 text-green-600" /></div><div><p className="text-xs text-muted-foreground">已付总额</p><p className="text-xl font-bold text-green-600">${totalPaid.toLocaleString()}</p></div></CardContent></Card>
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-blue-50"><CreditCard className="h-4 w-4 text-blue-600" /></div><div><p className="text-xs text-muted-foreground">应付笔数</p><p className="text-xl font-bold">{records.length}</p></div></CardContent></Card>
          <Card className={overBudgetCount > 0 ? 'border-red-200' : ''}><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-red-50"><AlertTriangle className="h-4 w-4 text-red-600" /></div><div><p className="text-xs text-muted-foreground">超预算</p><p className={`text-xl font-bold ${overBudgetCount > 0 ? 'text-red-600' : ''}`}>{overBudgetCount}</p></div></CardContent></Card>
        </div>

        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              <TabsTrigger value="all">全部 ({records.length})</TabsTrigger>
              <TabsTrigger value="unpaid">待审批</TabsTrigger>
              <TabsTrigger value="approved">待付款</TabsTrigger>
              <TabsTrigger value="paid">已付款</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative max-w-sm"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input placeholder="搜索供应商/订单号..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} /></div>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground"><CreditCard className="h-12 w-12 mx-auto mb-3 opacity-30" /><p>暂无应付记录</p><p className="text-xs mt-1">应付从订单决算确认后自动产生</p></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>供应商</TableHead>
                    <TableHead>订单号</TableHead>
                    <TableHead>费用类别</TableHead>
                    <TableHead className="text-right">金额</TableHead>
                    <TableHead className="text-right">预算</TableHead>
                    <TableHead>到期日</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(r => (
                    <TableRow key={r.id} className={r.over_budget ? 'bg-red-50/50' : ''}>
                      <TableCell className="font-medium">{r.supplier_name}</TableCell>
                      <TableCell className="text-sm text-primary">{r.order_no || '-'}</TableCell>
                      <TableCell><Badge variant="outline">{r.cost_category || '-'}</Badge></TableCell>
                      <TableCell className="text-right font-semibold">{r.currency} {r.amount.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {r.budget_amount != null ? `${r.currency} ${r.budget_amount.toLocaleString()}` : '-'}
                        {r.over_budget && <span className="text-red-600 ml-1">超支</span>}
                      </TableCell>
                      <TableCell className="text-sm">{r.due_date || '-'}</TableCell>
                      <TableCell><Badge className={`${statusConfig[r.payment_status]?.color || ''} border-0`}>{statusConfig[r.payment_status]?.label}</Badge></TableCell>
                      <TableCell className="text-center">
                        {r.payment_status === 'unpaid' && <Button size="sm" onClick={() => handleApprove(r.id)} disabled={processing}><CheckCircle className="h-3.5 w-3.5 mr-1" />审批</Button>}
                        {r.payment_status === 'approved' && <Button size="sm" onClick={() => setPayDialog(r)} disabled={processing}><DollarSign className="h-3.5 w-3.5 mr-1" />付款</Button>}
                        {r.payment_status === 'paid' && <span className="text-xs text-green-600">✓ 已付</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {payDialog && (
        <Dialog open={true} onOpenChange={() => setPayDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>确认付款</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-muted-foreground">供应商: </span>{payDialog.supplier_name}</div>
                <div><span className="text-muted-foreground">金额: </span><span className="font-semibold">{payDialog.currency} {payDialog.amount.toLocaleString()}</span></div>
                <div><span className="text-muted-foreground">订单: </span>{payDialog.order_no || '-'}</div>
                <div><span className="text-muted-foreground">类别: </span>{payDialog.cost_category || '-'}</div>
              </div>
              {payDialog.over_budget && (
                <div className="flex items-center gap-2 p-2 bg-red-50 rounded-lg text-red-700 text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />超预算: 预算{payDialog.currency} {payDialog.budget_amount?.toLocaleString()} → 实际{payDialog.currency} {payDialog.amount.toLocaleString()}
                </div>
              )}
              <div className="space-y-2"><p className="text-sm font-medium">付款凭证号</p><Input placeholder="银行流水号" value={payRef} onChange={e => setPayRef(e.target.value)} /></div>
              <div className="space-y-2"><p className="text-sm font-medium">备注</p><Textarea placeholder="付款备注" value={payNote} onChange={e => setPayNote(e.target.value)} rows={2} /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPayDialog(null)}>取消</Button>
              <Button onClick={handlePay} disabled={processing}>{processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}确认付款</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
