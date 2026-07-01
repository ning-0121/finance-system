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
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DollarSign, Clock, CheckCircle, AlertTriangle, Loader2, Search, CreditCard, Plus, Pencil, Trash2 } from 'lucide-react'
import { getBudgetOrders } from '@/lib/supabase/queries'
import { getSuppliers } from '@/lib/supabase/queries-v2'
import { uploadAttachment, openAttachment, attachmentName } from '@/lib/supabase/storage'
import Link from 'next/link'
import type { BudgetOrder, Supplier } from '@/lib/types'
import { validatePayment, type ValidationWarning } from '@/lib/engines/validation-engine'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { getPayableRecords, createSupplierPayment } from '@/lib/supabase/queries-v2'
import type { PayableRecord, PaymentStatus } from '@/lib/types'

const statusConfig: Record<PaymentStatus, { label: string; color: string }> = {
  unpaid: { label: '待审批', color: 'bg-amber-100 text-amber-700' },
  pending_approval: { label: '审批中', color: 'bg-blue-100 text-blue-700' },
  approved: { label: '待付款', color: 'bg-purple-100 text-purple-700' },
  paid: { label: '已付款', color: 'bg-green-100 text-green-700' },
  cancelled: { label: '已取消', color: 'bg-gray-100 text-gray-700' },
}

// 付款方式：公账/私账/支付宝/微信
const PAYMENT_CHANNELS = [
  { value: 'company', label: '公账' },
  { value: 'personal', label: '私账' },
  { value: 'alipay', label: '支付宝' },
  { value: 'wechat', label: '微信' },
] as const
const channelLabel = (v: string | null | undefined) => PAYMENT_CHANNELS.find(c => c.value === v)?.label || null
const fmtDate = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : '-')

export default function PaymentsPage() {
  const [records, setRecords] = useState<PayableRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [payDialog, setPayDialog] = useState<PayableRecord | null>(null)
  const [payRef, setPayRef] = useState('')
  const [payNote, setPayNote] = useState('')
  // 付款前实时查重：null=未查；[]=查过无重复；[...]=有疑似重复，需二次确认
  const [dupSuspects, setDupSuspects] = useState<{ label: string; detail: string }[] | null>(null)
  const [dupChecking, setDupChecking] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [orders, setOrders] = useState<BudgetOrder[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [newSupplierId, setNewSupplierId] = useState('')
  const [newSupplier, setNewSupplier] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newBillNo, setNewBillNo] = useState('')  // 单据号：货代账单号/报关单号/发票号（防重复付款）
  const [newAmount, setNewAmount] = useState('')
  const [newOrderId, setNewOrderId] = useState('')
  const [newDueDate, setNewDueDate] = useState('')       // 付款日期（沿用 due_date 存储）
  const [newChannel, setNewChannel] = useState('')       // 付款方式 payment_channel
  const [newPayeeName, setNewPayeeName] = useState('')   // 收款人名称
  const [newPayeeAccount, setNewPayeeAccount] = useState('') // 收款银行账号
  const [newPayeeBank, setNewPayeeBank] = useState('')   // 开户行
  const [newAttachment, setNewAttachment] = useState('')
  const [uploadingAtt, setUploadingAtt] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)  // null=新增；非空=编辑该条
  const [channelFilter, setChannelFilter] = useState('all')        // 付款方式筛选
  const selectedSupplier = suppliers.find(s => s.id === newSupplierId) || null

  const handleAttUpload = async (file: File | undefined) => {
    if (!file) return
    setUploadingAtt(true)
    const { path, error } = await uploadAttachment(file, 'payments')
    setUploadingAtt(false)
    if (error) { toast.error(error); return }
    setNewAttachment(path || '')
    toast.success('附件已上传')
  }

  useEffect(() => {
    async function load() {
      const [data, ordersData, suppliersData] = await Promise.all([getPayableRecords(), getBudgetOrders(), getSuppliers()])
      setRecords(data)
      setOrders(ordersData)
      setSuppliers(suppliersData)
      setLoading(false)
    }
    load()
  }, [])

  const [payWarnings, setPayWarnings] = useState<ValidationWarning[]>([])

  const handleCreatePayable = async () => {
    if (!newSupplier.trim()) { toast.error('请输入供应商名称'); return }
    if (!newAmount || Number(newAmount) <= 0) { toast.error('请输入有效金额'); return }

    // 防错校验
    const warnings = validatePayment({
      amount: Number(newAmount),
      supplier: newSupplier.trim(),
      dueDate: newDueDate,
      existingPayables: records.map(r => ({ supplier: r.supplier_name, amount: r.amount })),
    })
    const errors = warnings.filter(w => w.level === 'error')
    if (errors.length > 0) { toast.error(errors[0].message); return }
    const warns = warnings.filter(w => w.level === 'warning')
    if (warns.length > 0 && payWarnings.length === 0) {
      setPayWarnings(warns)
      warns.forEach(w => toast.warning(w.message))
      return // 第一次显示警告，用户需要再次点击确认
    }
    setPayWarnings([])

    setProcessing(true)
    try {
      const supabase = createClient()
      // 银行收款信息快照（来自供应商信息库，避免手填出错）
      const bankSnapshot = selectedSupplier
        ? ['收款信息：', selectedSupplier.account_name && `户名 ${selectedSupplier.account_name}`, selectedSupplier.account_no && `账号 ${selectedSupplier.account_no}`, selectedSupplier.bank_name && `开户行 ${selectedSupplier.bank_name}`].filter(Boolean).join(' ')
        : ''
      // 防重复付款：同一供应商同一单据号只能有一条应付（应用层预检 + DB 唯一约束兜底）
      const billNo = newBillNo.trim()
      if (billNo) {
        let dupQ = supabase.from('payable_records')
          .select('id').eq('supplier_name', newSupplier.trim()).eq('bill_no', billNo).is('deleted_at', null)
        if (editingId) dupQ = dupQ.neq('id', editingId)   // 编辑时排除自身
        const { data: dup } = await dupQ.limit(1)
        if (dup && dup.length > 0) {
          toast.error(`单据号「${billNo}」在该供应商下已有应付记录，不可重复登记（疑似重复付款）`)
          setProcessing(false); return
        }
      }
      // 收款人默认取信息库户名/账号/开户行，可手改
      const payload = {
        supplier_name: newSupplier,
        description: newDesc || newSupplier,
        amount: Number(newAmount),
        budget_order_id: newOrderId || null,
        order_no: orders.find(o => o.id === newOrderId)?.order_no || null,
        bill_no: billNo || null,
        due_date: newDueDate || null,
        payment_channel: newChannel || null,
        payee_name: newPayeeName.trim() || null,
        payee_account: newPayeeAccount.trim() || null,
        payee_bank: newPayeeBank.trim() || null,
        attachment_url: newAttachment || null,
      }
      if (editingId) {
        const { data, error } = await supabase.from('payable_records')
          .update(payload).eq('id', editingId).select().single()
        if (error) {
          if (/payable_records_supplier_bill/.test(error.message)) { toast.error(`单据号「${billNo}」该供应商下已存在，不可重复登记`); setProcessing(false); return }
          throw error
        }
        setRecords(records.map(r => r.id === editingId ? (data as unknown as PayableRecord) : r))
        toast.success('付款申请已更新')
      } else {
        const { data, error } = await supabase.from('payable_records').insert({
          ...payload, currency: 'CNY', payment_status: 'unpaid', notes: bankSnapshot || null,
        }).select().single()
        if (error) {
          if (/payable_records_supplier_bill/.test(error.message)) { toast.error(`单据号「${billNo}」该供应商下已存在，不可重复登记（疑似重复付款）`); setProcessing(false); return }
          throw error
        }
        setRecords([data as unknown as PayableRecord, ...records])
        toast.success('付款申请已创建')
      }
      setShowCreate(false); resetForm()
    } catch (err) {
      toast.error(`${editingId ? '更新' : '创建'}失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
    setProcessing(false)
  }

  function resetForm() {
    setEditingId(null); setNewSupplierId(''); setNewSupplier(''); setNewDesc(''); setNewAmount('')
    setNewOrderId(''); setNewDueDate(''); setNewChannel(''); setNewPayeeName(''); setNewPayeeAccount('')
    setNewPayeeBank(''); setNewAttachment(''); setNewBillNo('')
  }

  function openCreate() { resetForm(); setShowCreate(true) }

  function openEdit(r: PayableRecord) {
    setEditingId(r.id)
    const sup = suppliers.find(s => s.name === r.supplier_name)
    setNewSupplierId(sup?.id || '')
    setNewSupplier(r.supplier_name || '')
    setNewDesc(r.description || '')
    setNewAmount(String(r.amount ?? ''))
    setNewBillNo(r.bill_no || '')
    setNewOrderId(r.budget_order_id || '')
    setNewDueDate(r.due_date ? String(r.due_date).slice(0, 10) : '')
    setNewChannel(r.payment_channel || '')
    setNewPayeeName(r.payee_name || '')
    setNewPayeeAccount(r.payee_account || '')
    setNewPayeeBank(r.payee_bank || '')
    setNewAttachment(r.attachment_url || '')
    setShowCreate(true)
  }

  async function handleDelete(r: PayableRecord) {
    if (r.payment_status === 'paid') { toast.error('已付款的记录不可删除，请走付款作废/红冲流程'); return }
    if (!confirm(`确认删除付款申请「${r.supplier_name} · ${r.currency} ${r.amount.toLocaleString()}」？删除后不参与统计（可在数据库软删除记录中追溯）。`)) return
    setProcessing(true)
    try {
      const supabase = createClient()
      const { data: userData } = await supabase.auth.getUser()
      const { error } = await supabase.from('payable_records')
        .update({ deleted_at: new Date().toISOString(), deleted_by: userData?.user?.id || null, delete_reason: '付款申请手动删除' })
        .eq('id', r.id)
      if (error) throw error
      setRecords(records.filter(x => x.id !== r.id))
      toast.success('已删除')
    } catch (err) { toast.error(`删除失败: ${err instanceof Error ? err.message : '未知错误'}`) }
    setProcessing(false)
  }

  const filtered = records.filter(r => {
    const matchFilter = filter === 'all' || r.payment_status === filter
    const matchSearch = !search || r.supplier_name.toLowerCase().includes(search.toLowerCase()) || (r.order_no || '').toLowerCase().includes(search.toLowerCase())
    const matchChannel = channelFilter === 'all' || r.payment_channel === channelFilter
    return matchFilter && matchSearch && matchChannel
  })

  const totalUnpaid = records.filter(r => r.payment_status !== 'paid' && r.payment_status !== 'cancelled').reduce((s, r) => s + r.amount, 0)
  const totalPaid = records.filter(r => r.payment_status === 'paid').reduce((s, r) => s + (r.paid_amount || r.amount), 0)
  const overBudgetCount = records.filter(r => r.over_budget).length

  const handleApprove = async (id: string) => {
    setProcessing(true)
    try {
      const supabase = createClient()
      // 状态前置条件：只允许从待审批状态变更，防并发重复审批/对已付记录误操作；
      // .select() 取命中行数——0 行说明状态已被他人变更（PostgREST 0 行更新不报错）
      const { data: hit, error } = await supabase.from('payable_records')
        .update({ payment_status: 'approved', approved_at: new Date().toISOString() })
        .eq('id', id)
        .in('payment_status', ['unpaid', 'pending_approval'])
        .select('id')
      if (error) throw error
      if (!hit || hit.length === 0) { toast.error('该记录状态已变更（可能已被他人审批/付款），请刷新后重试'); setProcessing(false); return }
      setRecords(records.map(r => r.id === id ? { ...r, payment_status: 'approved' as PaymentStatus } : r))
      toast.success('已审批通过')
    } catch (err) { toast.error(`审批失败: ${err instanceof Error ? err.message : '未知错误'}`) }
    setProcessing(false)
  }

  // 付款前实时查重：同供应商近30天「相同单据号」或「相同金额已付」即疑似重复
  const checkPaymentDuplicate = async (rec: PayableRecord): Promise<{ label: string; detail: string }[]> => {
    const supabase = createClient()
    const sinceDays = 30
    const since = new Date(Date.now() - sinceDays * 86400000).toISOString()
    const amt = Number(rec.amount) || 0
    const sup = (rec.supplier_name || '').trim()
    const billNo = (rec.bill_no || '').trim()
    const suspects: { label: string; detail: string }[] = []
    // ① 同供应商已付的应付：同单据号(最强) 或 同金额(近30天)
    const { data: pays } = await supabase.from('payable_records')
      .select('id, amount, bill_no, paid_at, description, order_no')
      .eq('supplier_name', sup).eq('payment_status', 'paid').neq('id', rec.id).limit(200)
    for (const p of pays || []) {
      const sameBill = billNo && (p.bill_no as string || '').trim() === billNo
      const sameAmt = Math.abs((Number(p.amount) || 0) - amt) < 0.01
      const recent = p.paid_at && new Date(p.paid_at as string).getTime() >= Date.parse(since)
      if (sameBill) suspects.push({ label: `同单据号已付：${p.order_no || p.description || ''}`, detail: `单据号 ${billNo}，金额 ${rec.currency} ${Number(p.amount).toLocaleString()}` })
      else if (sameAmt && recent) suspects.push({ label: `同金额已付（${sinceDays}天内）：${p.order_no || p.description || ''}`, detail: `${rec.currency} ${Number(p.amount).toLocaleString()} · 付于 ${(p.paid_at as string).slice(0, 10)}` })
    }
    // ② 供应商付款流水：同金额近30天（CNY 口径，外币不比金额避免误报）
    if ((rec.currency || 'CNY') === 'CNY') {
      const { data: sps } = await supabase.from('supplier_payments')
        .select('amount, paid_at, note').eq('supplier_name', sup).is('deleted_at', null).gte('paid_at', since.slice(0, 10)).limit(200)
      for (const s of sps || []) {
        if (Math.abs((Number(s.amount) || 0) - amt) < 0.01) suspects.push({ label: `付款流水同金额（${sinceDays}天内）`, detail: `¥${Number(s.amount).toLocaleString()} · ${(s.paid_at as string || '').slice(0, 10)}` })
      }
    }
    return suspects
  }

  const handlePay = async (force = false) => {
    if (!payDialog) return
    // 付款前实时查重：未强制时先查，命中则拦下要求二次确认
    if (!force) {
      setDupChecking(true)
      const suspects = await checkPaymentDuplicate(payDialog)
      setDupChecking(false)
      if (suspects.length > 0) { setDupSuspects(suspects); return }
      setDupSuspects([])
    }
    setProcessing(true)
    try {
      const supabase = createClient()
      // 前置条件：仅 approved 可付款（防两个出纳并发重复付款）；
      // notes 追加而非覆盖（创建时写入的收款账号快照是审计线索，不能丢）
      // force=用户在"疑似重复"提示后仍坚持付款 → 留痕（谁、何时确认的重复付款）
      const dupMark = force ? `[重复付款已人工确认 ${new Date().toLocaleString('zh-CN')}]` : ''
      const mergedNotes = [payDialog.notes, payNote ? `[付款备注] ${payNote}` : '', dupMark].filter(Boolean).join('\n') || null
      const { data: hit, error } = await supabase.from('payable_records').update({
        payment_status: 'paid', paid_at: new Date().toISOString(),
        paid_amount: payDialog.amount, payment_method: 'bank_transfer',
        payment_reference: payRef || null, notes: mergedNotes,
      }).eq('id', payDialog.id).eq('payment_status', 'approved').select('id')
      if (error) throw error
      if (!hit || hit.length === 0) { toast.error('该笔不是「已审批」状态（可能已被付款或被退回），请刷新后重试'); setProcessing(false); return }

      if (payDialog.invoice_id) {
        const { error: invoiceErr } = await supabase.from('actual_invoices').update({ status: 'paid' }).eq('id', payDialog.invoice_id)
        if (invoiceErr) toast.error(`发票状态更新失败: ${invoiceErr.message}`)
      }

      // 两套账打通（决议②）：出纳确认付款 → 自动同步一条供应商付款流水，
      // 应付工作台/对账单的「已付」随之减少，两边一个口径。幂等：note 带 payable id 防重复同步。
      try {
        const syncTag = `[出纳付款同步] payable:${payDialog.id}`
        const { data: dup } = await supabase.from('supplier_payments').select('id').ilike('note', `%payable:${payDialog.id}%`).is('deleted_at', null).limit(1)
        if (!dup || dup.length === 0) {
          // 折人民币：CNY 原值；外币用所属订单汇率，取不到则跳过同步并提醒手工登记（绝不按 1:1 折）
          let amountCny: number | null = null
          if ((payDialog.currency || 'CNY') === 'CNY') {
            amountCny = Number(payDialog.amount) || 0
          } else if (payDialog.budget_order_id) {
            const { data: bo } = await supabase.from('budget_orders').select('currency, exchange_rate').eq('id', payDialog.budget_order_id).maybeSingle()
            const rate = bo && bo.currency !== 'CNY' ? Number(bo.exchange_rate) : 0
            if (rate > 0) amountCny = Math.round((Number(payDialog.amount) || 0) * rate * 100) / 100
          }
          if (amountCny != null && amountCny > 0) {
            const { error: syncErr } = await createSupplierPayment({
              supplier_name: payDialog.supplier_name,
              amount: amountCny,
              currency: 'CNY',
              paid_at: new Date().toISOString(),
              note: `${syncTag} ${payDialog.description || ''}${payDialog.currency !== 'CNY' ? `（原币 ${payDialog.currency} ${payDialog.amount}）` : ''}`.trim(),
            })
            if (syncErr) toast.warning(`付款已确认，但同步到应付工作台失败：${syncErr}。请到供应商对账单手工登记付款`)
          } else if ((payDialog.currency || 'CNY') !== 'CNY') {
            toast.warning('付款已确认，但该笔为外币且无订单汇率，未自动同步应付工作台——请到供应商对账单手工登记付款（填准确人民币金额）')
          }
        }
      } catch (syncEx) {
        console.error('[付款同步] 写供应商付款流水失败:', syncEx)
        toast.warning('付款已确认，但同步应付工作台失败，请到供应商对账单手工登记付款')
      }

      setRecords(records.map(r => r.id === payDialog.id ? { ...r, payment_status: 'paid' as PaymentStatus } : r))
      toast.success('付款完成（已同步应付工作台）')
      setPayDialog(null); setPayRef(''); setPayNote(''); setDupSuspects(null)
    } catch (err) { toast.error(`付款失败: ${err instanceof Error ? err.message : '未知错误'}`) }
    setProcessing(false)
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="付款审批与出纳" subtitle="应付从决算中自动产生 · 审批→付款→回写发票状态" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-amber-50"><DollarSign className="h-4 w-4 text-amber-600" /></div><div><p className="text-xs text-muted-foreground">待付总额</p><p className="text-xl font-bold text-amber-600">¥{totalUnpaid.toLocaleString()}</p></div></CardContent></Card>
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-green-50"><CheckCircle className="h-4 w-4 text-green-600" /></div><div><p className="text-xs text-muted-foreground">已付总额</p><p className="text-xl font-bold text-green-600">¥{totalPaid.toLocaleString()}</p></div></CardContent></Card>
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
          <div className="flex items-center gap-2">
            <div className="relative max-w-sm"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input placeholder="搜索供应商/订单号..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} /></div>
            <Select value={channelFilter} onValueChange={v => setChannelFilter(v || 'all')}>
              <SelectTrigger className="w-[130px]"><SelectValue placeholder="付款方式" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部方式</SelectItem>
                {PAYMENT_CHANNELS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新增付款申请</Button>
          </div>
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
                    <TableHead>付款方式</TableHead>
                    <TableHead className="text-right">金额</TableHead>
                    <TableHead className="text-right">预算</TableHead>
                    <TableHead>付款日期</TableHead>
                    <TableHead>提交时间</TableHead>
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
                      <TableCell className="text-sm">{channelLabel(r.payment_channel) || '-'}</TableCell>
                      <TableCell className="text-right font-semibold">{r.currency} {r.amount.toLocaleString()}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {r.budget_amount != null ? `${r.currency} ${r.budget_amount.toLocaleString()}` : '-'}
                        {r.over_budget && <span className="text-red-600 ml-1">超支</span>}
                      </TableCell>
                      <TableCell className="text-sm">{fmtDate(r.due_date)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDate(r.created_at)}</TableCell>
                      <TableCell><Badge className={`${statusConfig[r.payment_status]?.color || ''} border-0`}>{statusConfig[r.payment_status]?.label}</Badge></TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          {r.payment_status === 'unpaid' && <Button size="sm" onClick={() => handleApprove(r.id)} disabled={processing}><CheckCircle className="h-3.5 w-3.5 mr-1" />审批</Button>}
                          {r.payment_status === 'approved' && <Button size="sm" onClick={() => { setPayDialog(r); setDupSuspects(null) }} disabled={processing}><DollarSign className="h-3.5 w-3.5 mr-1" />付款</Button>}
                          {r.payment_status === 'paid' && <span className="text-xs text-green-600 mr-1">✓ 已付</span>}
                          {r.payment_status !== 'paid' && (
                            <>
                              <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => openEdit(r)} disabled={processing}><Pencil className="h-3.5 w-3.5" /></Button>
                              <Button size="sm" variant="outline" className="h-7 px-2 text-red-600 hover:text-red-700" onClick={() => handleDelete(r)} disabled={processing}><Trash2 className="h-3.5 w-3.5" /></Button>
                            </>
                          )}
                        </div>
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
                {channelLabel(payDialog.payment_channel) && <div><span className="text-muted-foreground">付款方式: </span>{channelLabel(payDialog.payment_channel)}</div>}
                {payDialog.due_date && <div><span className="text-muted-foreground">付款日期: </span>{fmtDate(payDialog.due_date)}</div>}
              </div>
              {(payDialog.payee_name || payDialog.payee_account || payDialog.payee_bank) && (
                <div className="text-xs bg-muted/40 rounded-md p-2 space-y-0.5">
                  <div className="flex justify-between"><span className="text-muted-foreground">收款人</span><span className="font-medium">{payDialog.payee_name || '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">账号</span><span className="font-mono">{payDialog.payee_account || '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">开户行</span><span>{payDialog.payee_bank || '—'}</span></div>
                </div>
              )}
              {payDialog.over_budget && (
                <div className="flex items-center gap-2 p-2 bg-red-50 rounded-lg text-red-700 text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />超预算: 预算{payDialog.currency} {payDialog.budget_amount?.toLocaleString()} → 实际{payDialog.currency} {payDialog.amount.toLocaleString()}
                </div>
              )}
              <div className="space-y-2"><p className="text-sm font-medium">付款凭证号</p><Input placeholder="银行流水号" value={payRef} onChange={e => setPayRef(e.target.value)} /></div>
              <div className="space-y-2"><p className="text-sm font-medium">备注</p><Textarea placeholder="付款备注" value={payNote} onChange={e => setPayNote(e.target.value)} rows={2} /></div>
              {dupSuspects && dupSuspects.length > 0 && (
                <div className="p-3 bg-red-50 border border-red-300 rounded-lg space-y-1">
                  <p className="text-sm font-semibold text-red-700 flex items-center gap-1"><AlertTriangle className="h-4 w-4" />疑似重复付款（{dupSuspects.length} 条），请务必核对后再付！</p>
                  {dupSuspects.slice(0, 5).map((s, i) => (
                    <p key={i} className="text-xs text-red-700">· {s.label} —— {s.detail}</p>
                  ))}
                  <p className="text-[11px] text-muted-foreground mt-1">确认不是重复（如分批付款/不同票）才继续；坚持付款将记录到付款备注备查。</p>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPayDialog(null)}>取消</Button>
              {dupSuspects && dupSuspects.length > 0 ? (
                <Button variant="destructive" onClick={() => handlePay(true)} disabled={processing}>{processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <AlertTriangle className="h-4 w-4 mr-1" />}已核对无重复，仍要付款</Button>
              ) : (
                <Button onClick={() => handlePay(false)} disabled={processing || dupChecking}>{(processing || dupChecking) ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}{dupChecking ? '查重中…' : '确认付款'}</Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 新增/编辑 付款申请弹窗 */}
      <Dialog open={showCreate} onOpenChange={o => { setShowCreate(o); if (!o) resetForm() }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editingId ? '编辑付款申请' : '新增付款申请'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>供应商 *（从信息库选择，自动带出银行信息）</Label>
              {suppliers.length === 0 ? (
                <div className="text-xs text-amber-600 border border-amber-200 rounded-md p-2">
                  供应商信息库为空。请先到 <Link href="/profiles/suppliers" className="text-primary underline">供应商信息库</Link> 建档（含账号/户名/开户行），再回来选择。
                </div>
              ) : (
                <Select value={newSupplierId} onValueChange={v => {
                  const id = v || ''; const s = suppliers.find(x => x.id === id)
                  setNewSupplierId(id); setNewSupplier(s?.name || '')
                  // 自动带出收款人（户名/账号/开户行），仍可手改
                  setNewPayeeName(s?.account_name || s?.name || '')
                  setNewPayeeAccount(s?.account_no || '')
                  setNewPayeeBank(s?.bank_name || '')
                }}>
                  <SelectTrigger>{selectedSupplier ? <span className="truncate">{selectedSupplier.name}</span> : <SelectValue placeholder="选择供应商" />}</SelectTrigger>
                  <SelectContent>
                    {suppliers.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              {selectedSupplier && (
                <div className="text-xs bg-muted/40 rounded-md p-2 space-y-0.5 mt-1">
                  <div className="flex justify-between"><span className="text-muted-foreground">户名</span><span className="font-medium">{selectedSupplier.account_name || '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">账号</span><span className="font-mono">{selectedSupplier.account_no || '—'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">开户行</span><span>{selectedSupplier.bank_name || '—'}</span></div>
                  {(!selectedSupplier.account_no || !selectedSupplier.bank_name) && (
                    <p className="text-amber-600 pt-1">该供应商银行信息不全，建议到信息库补全。</p>
                  )}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>费用说明</Label>
              <Input placeholder="如：2024春季面料尾款" value={newDesc} onChange={e => setNewDesc(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>单据号（货代账单号 / 报关单号 / 发票号）</Label>
              <Input placeholder="货代费务必填报关单号/航次号——防同一票重复付款" value={newBillNo} onChange={e => setNewBillNo(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">同一供应商同一单据号只能登记一次，系统自动拦截重复。</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>金额 (¥) *</Label>
                <Input type="number" step="0.01" placeholder="0.00" value={newAmount} onChange={e => setNewAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>付款日期</Label>
                <Input type="date" value={newDueDate} onChange={e => setNewDueDate(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>付款方式</Label>
              <Select value={newChannel || '__none__'} onValueChange={v => setNewChannel(!v || v === '__none__' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="选择付款方式" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">未指定</SelectItem>
                  {PAYMENT_CHANNELS.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>收款信息（选供应商自动带出，可修改）</Label>
              <Input placeholder="收款人名称" value={newPayeeName} onChange={e => setNewPayeeName(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="银行账号" value={newPayeeAccount} onChange={e => setNewPayeeAccount(e.target.value)} />
                <Input placeholder="开户行" value={newPayeeBank} onChange={e => setNewPayeeBank(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>关联订单（可选）</Label>
              {/* Radix Select 不允许空字符串值，用哨兵值 __none__ 表示「不关联」并映射回空 */}
              <Select value={newOrderId || '__none__'} onValueChange={v => setNewOrderId(v === '__none__' ? '' : (v || ''))}>
                <SelectTrigger><SelectValue placeholder="不关联" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不关联（仅记到供应商）</SelectItem>
                  {orders.map(o => (
                    <SelectItem key={o.id} value={o.id}>{o.order_no} - {o.customer?.company || ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>插入附件（发票/合同/银行回单等，可选）</Label>
              {newAttachment ? (
                <div className="flex items-center gap-2 text-sm">
                  <button type="button" className="text-primary underline truncate max-w-[220px]" onClick={() => openAttachment(newAttachment)}>{attachmentName(newAttachment)}</button>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-red-500" onClick={() => setNewAttachment('')}>移除</Button>
                </div>
              ) : (
                <Input type="file" disabled={uploadingAtt} onChange={e => handleAttUpload(e.target.files?.[0])} className="text-xs" />
              )}
              {uploadingAtt && <p className="text-[11px] text-muted-foreground">上传中…</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); resetForm() }}>取消</Button>
            <Button onClick={handleCreatePayable} disabled={processing}>
              {processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              {editingId ? '保存修改' : '创建付款申请'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
