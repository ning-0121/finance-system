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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command'
import { DollarSign, Clock, CheckCircle, AlertTriangle, Loader2, Search, CreditCard, Plus, Pencil, Trash2, ChevronsUpDown, History } from 'lucide-react'
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

// 用 Record<string> 而非 Record<PaymentStatus>:DB 里有 partially_paid(部分已付),但共享类型没列;
// 这里补上标签,修此前「部分已付」显示空白徽章的 bug(不动共享类型,避免牵连其它文件)。
const statusConfig: Record<string, { label: string; color: string }> = {
  unpaid: { label: '待审批', color: 'bg-amber-100 text-amber-700' },
  pending_approval: { label: '审批中', color: 'bg-blue-100 text-blue-700' },
  approved: { label: '待付款', color: 'bg-purple-100 text-purple-700' },
  partially_paid: { label: '部分已付', color: 'bg-orange-100 text-orange-700' },
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
  const [orderSyncMap, setOrderSyncMap] = useState<Record<string, { internalNo: string; qmNo: string; customer: string }>>({})
  const [orderPickerOpen, setOrderPickerOpen] = useState(false)  // 关联订单可搜索下拉
  // 分批付款历史(A):某笔应付的逐次付款(周排款分批 executed 行;直接付款用应付自身)
  const [histFor, setHistFor] = useState<PayableRecord | null>(null)
  const [histRows, setHistRows] = useState<{ date: string | null; amount: number; currency: string; ref: string | null; source: string }[]>([])
  const [histLoading, setHistLoading] = useState(false)
  const [expandedSups, setExpandedSups] = useState<Set<string>>(new Set())  // 按供应商汇总:展开看各月
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supPickerOpen, setSupPickerOpen] = useState(false)  // 供应商可搜索下拉
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
  const [attError, setAttError] = useState('')  // 附件上传失败提示:醒目、持久,绝不静默(否则会误存空附件)
  const [editingId, setEditingId] = useState<string | null>(null)  // null=新增；非空=编辑该条
  const [channelFilter, setChannelFilter] = useState('all')        // 付款方式筛选
  const selectedSupplier = suppliers.find(s => s.id === newSupplierId) || null

  const handleAttUpload = async (file: File | undefined) => {
    if (!file) return
    setAttError('')
    setUploadingAtt(true)
    const { path, error } = await uploadAttachment(file, 'payments')
    setUploadingAtt(false)
    // 上传失败(如会话过期→存储 RLS 拒绝)必须显性报错并停下:不能让"看似选了文件、实则没传上"的记录静默保存
    if (error || !path) {
      const msg = error || '上传失败,请重试'
      setAttError(msg)
      toast.error(`附件上传失败:${msg}`)
      return
    }
    setNewAttachment(path)
    toast.success('附件已上传')
  }

  useEffect(() => {
    async function load() {
      const [data, ordersData, suppliersData] = await Promise.all([getPayableRecords(), getBudgetOrders(), getSuppliers()])
      setRecords(data)
      setOrders(ordersData)
      setSuppliers(suppliersData)
      // 关联订单下拉要能按【内部订单号/绮陌号/客户】搜(否则只有 BO 号,内部号如 1022934 搜不到)
      try {
        const { createClient } = await import('@/lib/supabase/client')
        const supabase = createClient()
        const { data: synced } = await supabase.from('synced_orders')
          .select('budget_order_id, order_no, style_no, customer_name').not('budget_order_id', 'is', null)
        const map: Record<string, { internalNo: string; qmNo: string; customer: string }> = {}
        for (const s of (synced as Array<Record<string, unknown>>) || []) {
          if (s.budget_order_id) map[s.budget_order_id as string] = {
            internalNo: (s.style_no as string) || '', qmNo: (s.order_no as string) || '', customer: (s.customer_name as string) || '',
          }
        }
        setOrderSyncMap(map)
      } catch { /* 关联订单搜索增强失败不影响主流程 */ }
      setLoading(false)
    }
    load()
  }, [])

  const [payWarnings, setPayWarnings] = useState<ValidationWarning[]>([])

  const handleCreatePayable = async () => {
    if (!newSupplier.trim()) { toast.error('请输入供应商名称'); return }
    if (!newAmount || Number(newAmount) <= 0) { toast.error('请输入有效金额'); return }
    // 附件仍在上传时保存会漏存 attachment_url(竞态:上传未完成 newAttachment 还是空)→ 拦住,让附件先落地
    if (uploadingAtt) { toast.error('附件正在上传，请稍候再保存'); return }
    // 附件上传失败却未处理时,别把"没附件"的记录静默存进去 → 逼用户重试或明确点「不加附件」
    if (attError) { toast.error('附件上传失败，请点『重试』重新上传，或点『不加附件继续』后再保存'); return }

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
    setNewPayeeBank(''); setNewAttachment(''); setNewBillNo(''); setAttError(''); setUploadingAtt(false)
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
    setAttError(''); setUploadingAtt(false)
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

  // KPI 分币种统计——payable_records 无自带汇率,不同币种直加会失真(审计 P1 混币):
  // CNY 直加;外币单独归集,展示为 "¥X + $Y" 形式
  const sumByCur = (rs: PayableRecord[], amt: (r: PayableRecord) => number) => {
    const m = new Map<string, number>()
    rs.forEach(r => { const c = (r.currency || 'CNY').toUpperCase(); m.set(c, (m.get(c) || 0) + amt(r)) })
    return m
  }
  const fmtMulti = (m: Map<string, number>) => {
    const parts: string[] = []
    if (m.has('CNY')) parts.push(`¥${Math.round(m.get('CNY')!).toLocaleString()}`)
    for (const [c, v] of m) if (c !== 'CNY') parts.push(`${c} ${Math.round(v).toLocaleString()}`)
    return parts.length ? parts.join(' + ') : '¥0'
  }
  const totalUnpaidStr = fmtMulti(sumByCur(records.filter(r => r.payment_status !== 'paid' && r.payment_status !== 'cancelled'), r => r.amount))
  const totalPaidStr = fmtMulti(sumByCur(records.filter(r => r.payment_status === 'paid'), r => r.paid_amount || r.amount))
  const overBudgetCount = records.filter(r => r.over_budget).length

  const openHistory = async (r: PayableRecord) => {
    setHistFor(r); setHistRows([]); setHistLoading(true)
    try {
      const supabase = createClient()
      // 分批:周排款已放款的行(payment_batch_lines,status=paid);逐次的凭证号/金额/时间都在这
      const { data: lines } = await supabase.from('payment_batch_lines')
        .select('pay_amount, currency, payment_ref, executed_at').eq('payable_id', r.id).is('deleted_at', null).eq('status', 'paid').order('executed_at')
      const rows = ((lines as Array<Record<string, unknown>>) || []).map(l => ({
        date: (l.executed_at as string) || null, amount: Number(l.pay_amount) || 0,
        currency: (l.currency as string) || r.currency, ref: (l.payment_ref as string) || null, source: '周排款分批',
      }))
      // 直接付款(未走周排款):用应付自身的 paid_at/凭证。仅当无分批行时补,避免与分批重复计。
      const rr = r as unknown as { paid_at?: string; payment_reference?: string }
      if (rows.length === 0 && rr.paid_at) {
        rows.push({ date: rr.paid_at || null, amount: Number(r.paid_amount) || 0, currency: r.currency, ref: rr.payment_reference || null, source: '直接付款' })
      }
      setHistRows(rows)
    } catch { /* 历史拉取失败不阻断 */ }
    setHistLoading(false)
  }

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
      .select('id, amount, currency, bill_no, paid_at, description, order_no')
      .eq('supplier_name', sup).eq('payment_status', 'paid').neq('id', rec.id).limit(200)
    for (const p of pays || []) {
      const sameBill = billNo && (p.bill_no as string || '').trim() === billNo
      // 同金额需同币种，否则 USD 1000 会误判为 CNY 1000（外币主要靠单据号防重）
      const sameAmt = ((p.currency as string) || 'CNY') === (rec.currency || 'CNY') && Math.abs((Number(p.amount) || 0) - amt) < 0.01
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
    // 审计 P1:该应付若已排入周排款单(存在未关闭排款行),不能再走直接付款——否则整额覆盖
    // paid_amount 会留下永远执行不了的孤儿排款行、排款单关不掉。引导到排款页放款。
    {
      const supabase = createClient()
      const { data: openLines } = await supabase.from('payment_batch_lines')
        .select('id').eq('payable_id', payDialog.id).is('deleted_at', null)
        .in('status', ['planned', 'held']).limit(1)
      if (openLines && openLines.length > 0) {
        toast.error('该应付已排入「周排款」单，请到 周排款(付款执行) 页放款，勿在此直接付款（避免重复付款/孤儿排款行）。')
        return
      }
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
        // 幂等改用结构化列 source_payable_id(替代 note 模糊匹配——note 可被编辑/清空致幂等失效)
        const { data: dup } = await supabase.from('supplier_payments').select('id').eq('source_payable_id', payDialog.id).is('deleted_at', null).limit(1)
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
              source_payable_id: payDialog.id,
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
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-amber-50"><DollarSign className="h-4 w-4 text-amber-600" /></div><div><p className="text-xs text-muted-foreground">待付总额</p><p className="text-xl font-bold text-amber-600">{totalUnpaidStr}</p></div></CardContent></Card>
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-green-50"><CheckCircle className="h-4 w-4 text-green-600" /></div><div><p className="text-xs text-muted-foreground">已付总额</p><p className="text-xl font-bold text-green-600">{totalPaidStr}</p></div></CardContent></Card>
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
              <TabsTrigger value="by_supplier">按供应商汇总</TabsTrigger>
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
            ) : filter === 'by_supplier' ? (
              (() => {
                // B:按【供应商+币种】聚合,可展开看各月(账期月 due_date)应付/已付/未付。适合"按月送货结款"。
                type MG = { count: number; total: number; paid: number }
                const byKey = new Map<string, { key: string; supplier: string; currency: string; count: number; total: number; paid: number; months: Map<string, MG> }>()
                for (const r of records) {
                  if (r.payment_status === 'cancelled') continue
                  const key = `${r.supplier_name}|||${r.currency}`
                  const g = byKey.get(key) || { key, supplier: r.supplier_name, currency: r.currency, count: 0, total: 0, paid: 0, months: new Map<string, MG>() }
                  const amt = Number(r.amount) || 0, paid = Number(r.paid_amount) || 0
                  g.count++; g.total += amt; g.paid += paid
                  const mo = r.due_date ? String(r.due_date).slice(0, 7) : '无账期'
                  const mg = g.months.get(mo) || { count: 0, total: 0, paid: 0 }
                  mg.count++; mg.total += amt; mg.paid += paid; g.months.set(mo, mg)
                  byKey.set(key, g)
                }
                const rows = [...byKey.values()].map(g => ({ ...g, unpaid: Math.round((g.total - g.paid) * 100) / 100 })).sort((a, b) => b.unpaid - a.unpaid)
                const toggle = (k: string) => setExpandedSups(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
                return (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>供应商 / 月份</TableHead>
                      <TableHead className="text-right">笔数</TableHead>
                      <TableHead className="text-right">应付合计</TableHead>
                      <TableHead className="text-right">已付</TableHead>
                      <TableHead className="text-right">未付</TableHead>
                      <TableHead></TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {rows.flatMap(g => {
                        const open = expandedSups.has(g.key)
                        const months = [...g.months.entries()].map(([mo, mg]) => ({ mo, ...mg, unpaid: Math.round((mg.total - mg.paid) * 100) / 100 })).sort((a, b) => (a.mo < b.mo ? 1 : -1))
                        const out = [
                          <TableRow key={g.key} className="hover:bg-muted/40">
                            <TableCell className="font-medium">
                              <button onClick={() => toggle(g.key)} className="inline-flex items-center gap-1 hover:text-primary">
                                <span className="text-muted-foreground w-3 inline-block text-center">{open ? '▾' : '▸'}</span>{g.supplier}
                              </button>
                            </TableCell>
                            <TableCell className="text-right">{g.count}</TableCell>
                            <TableCell className="text-right font-semibold">{g.currency} {g.total.toLocaleString()}</TableCell>
                            <TableCell className="text-right text-green-600">{g.paid.toLocaleString()}</TableCell>
                            <TableCell className={`text-right font-semibold ${g.unpaid > 0.005 ? 'text-orange-600' : 'text-muted-foreground'}`}>{g.unpaid.toLocaleString()}</TableCell>
                            <TableCell className="text-right"><Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => { setSearch(g.supplier); setFilter('all') }}>看明细</Button></TableCell>
                          </TableRow>,
                        ]
                        if (open) for (const mm of months) out.push(
                          <TableRow key={`${g.key}|${mm.mo}`} className="bg-muted/20 text-sm">
                            <TableCell className="pl-8 text-muted-foreground">{mm.mo}</TableCell>
                            <TableCell className="text-right text-muted-foreground">{mm.count}</TableCell>
                            <TableCell className="text-right">{g.currency} {mm.total.toLocaleString()}</TableCell>
                            <TableCell className="text-right text-green-600">{mm.paid.toLocaleString()}</TableCell>
                            <TableCell className={`text-right ${mm.unpaid > 0.005 ? 'text-orange-600' : 'text-muted-foreground'}`}>{mm.unpaid.toLocaleString()}</TableCell>
                            <TableCell></TableCell>
                          </TableRow>,
                        )
                        return out
                      })}
                      {rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-12 text-muted-foreground">暂无应付</TableCell></TableRow>}
                    </TableBody>
                  </Table>
                )
              })()
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
                      <TableCell className="text-right font-semibold">
                        {r.currency} {r.amount.toLocaleString()}
                        {Number(r.paid_amount) > 0 && (
                          <div className="text-[11px] font-normal text-muted-foreground mt-0.5">
                            已付 {Number(r.paid_amount).toLocaleString()} · 剩 <span className={(r.amount - Number(r.paid_amount)) > 0.005 ? 'text-orange-600' : 'text-green-600'}>{(r.amount - Number(r.paid_amount)).toLocaleString()}</span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {r.budget_amount != null ? `${r.currency} ${r.budget_amount.toLocaleString()}` : '-'}
                        {r.over_budget && <span className="text-red-600 ml-1">超支</span>}
                      </TableCell>
                      <TableCell className="text-sm">{fmtDate(r.due_date)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{fmtDate(r.created_at)}</TableCell>
                      <TableCell><Badge className={`${statusConfig[r.payment_status]?.color || ''} border-0`}>{statusConfig[r.payment_status]?.label}</Badge></TableCell>
                      <TableCell className="text-center">
                        <div className="flex items-center justify-center gap-1">
                          {Number(r.paid_amount) > 0 && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => openHistory(r)} title="分批付款历史"><History className="h-3.5 w-3.5 mr-1" />明细</Button>}
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

      {/* 分批付款历史(A):这笔应付分了几次付、各付多少、凭证号、走哪条渠道 */}
      {histFor && (
        <Dialog open={true} onOpenChange={() => setHistFor(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>分批付款历史 · {histFor.supplier_name}</DialogTitle></DialogHeader>
            <div className="space-y-2 py-1 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>应付 {histFor.currency} {histFor.amount.toLocaleString()}</span>
                <span>已付 {Number(histFor.paid_amount).toLocaleString()} · 剩 <span className={(histFor.amount - Number(histFor.paid_amount)) > 0.005 ? 'text-orange-600' : 'text-green-600'}>{(histFor.amount - Number(histFor.paid_amount)).toLocaleString()}</span></span>
              </div>
              {histLoading ? (
                <div className="py-6 text-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-1" />加载中…</div>
              ) : histRows.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground">暂无付款记录</div>
              ) : (
                <div className="rounded-lg border divide-y">
                  {histRows.map((h, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-2">
                      <div>
                        <div className="font-medium">{h.currency} {h.amount.toLocaleString()}</div>
                        <div className="text-[11px] text-muted-foreground">{h.date ? new Date(h.date).toLocaleDateString('zh-CN') : '—'} · {h.source}</div>
                      </div>
                      <div className="text-[11px] text-muted-foreground text-right">凭证号 <span className="font-mono text-foreground">{h.ref || '—'}</span></div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <DialogFooter><Button variant="outline" onClick={() => setHistFor(null)}>关闭</Button></DialogFooter>
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
                <Popover open={supPickerOpen} onOpenChange={setSupPickerOpen}>
                  <PopoverTrigger render={<Button type="button" variant="outline" className="w-full justify-between font-normal" />}>
                    {selectedSupplier ? <span className="truncate">{selectedSupplier.name}</span> : <span className="text-muted-foreground">选择供应商（可搜名字）</span>}
                    <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-[min(92vw,380px)] p-0">
                    {/* 自定义 filter:按 名字/户名 大小写不敏感子串,保证中文可搜(cmdk 默认 fuzzy 对中文不稳) */}
                    <Command filter={(value, search) => value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
                      <CommandInput placeholder="输供应商名或片段搜索…" />
                      <CommandList className="max-h-64">
                        <CommandEmpty>没找到该供应商，换个关键词或先去信息库建档</CommandEmpty>
                        {suppliers.map(s => (
                          <CommandItem key={s.id} value={`${s.name} ${s.account_name || ''}`} onSelect={() => {
                            setNewSupplierId(s.id); setNewSupplier(s.name || '')
                            // 自动带出收款人（户名/账号/开户行），仍可手改
                            setNewPayeeName(s.account_name || s.name || '')
                            setNewPayeeAccount(s.account_no || '')
                            setNewPayeeBank(s.bank_name || '')
                            setSupPickerOpen(false)
                          }}>{s.name}</CommandItem>
                        ))}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
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
              {(() => {
                const selOrder = orders.find(o => o.id === newOrderId)
                const sm = newOrderId ? orderSyncMap[newOrderId] : undefined
                const cust = sm?.customer || selOrder?.customer?.company || ''
                return (
                  <Popover open={orderPickerOpen} onOpenChange={setOrderPickerOpen}>
                    <PopoverTrigger render={<Button type="button" variant="outline" className="w-full justify-between font-normal" />}>
                      {selOrder
                        ? <span className="truncate">{selOrder.order_no}{sm?.internalNo ? ` · 内部 ${sm.internalNo}` : ''}{cust ? ` · ${cust}` : ''}</span>
                        : <span className="text-muted-foreground">不关联 · 可搜订单号/内部号/客户</span>}
                      <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-[min(92vw,440px)] p-0">
                      {/* 搜索文本含 内部订单号/绮陌号/客户 → 输 1022934 这类内部号也能命中 */}
                      <Command filter={(value, search) => value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0}>
                        <CommandInput placeholder="搜 订单号 / 内部号(如 1022934) / 客户…" />
                        <CommandList className="max-h-64">
                          <CommandEmpty>没找到。若内部号也搜不到,可能该订单还没建预算单。</CommandEmpty>
                          <CommandItem value="不关联 none" onSelect={() => { setNewOrderId(''); setOrderPickerOpen(false) }}>不关联（仅记到供应商）</CommandItem>
                          {orders.map(o => {
                            const m = orderSyncMap[o.id]
                            const c = m?.customer || o.customer?.company || ''
                            return (
                              <CommandItem key={o.id} value={`${o.order_no} ${m?.internalNo || ''} ${m?.qmNo || ''} ${c}`}
                                onSelect={() => { setNewOrderId(o.id); setOrderPickerOpen(false) }}>
                                <span className="truncate">
                                  {o.order_no}
                                  {m?.internalNo ? <span className="text-muted-foreground"> · 内部 {m.internalNo}</span> : null}
                                  {c ? <span className="text-muted-foreground"> · {c}</span> : null}
                                </span>
                              </CommandItem>
                            )
                          })}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                )
              })()}
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
              {attError && !uploadingAtt && (
                <div className="rounded-md border border-red-300 bg-red-50 px-2.5 py-2 text-[12px] text-red-700 space-y-1">
                  <p>⚠️ 附件上传失败:{attError}</p>
                  <p className="text-red-600/80">此付款尚未附加文件。请重新选择文件重试;若确不需附件,可点「不加附件继续」。</p>
                  <button type="button" className="underline" onClick={() => setAttError('')}>不加附件继续</button>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); resetForm() }}>取消</Button>
            <Button onClick={handleCreatePayable} disabled={processing || uploadingAtt}>
              {(processing || uploadingAtt) ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
              {uploadingAtt ? '附件上传中…' : (editingId ? '保存修改' : '创建付款申请')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
