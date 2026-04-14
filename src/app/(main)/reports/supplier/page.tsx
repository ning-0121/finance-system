'use client'

import React, { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Search, Download, DollarSign, FileText, Clock, CheckCircle, Lock, Loader2, AlertTriangle, Edit } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { exportCostSummaryReport } from '@/lib/excel/export-professional'

interface SupplierLine {
  supplier: string
  count: number
  total: number
  paid: number
  unpaid: number
  currency: string
  orders: string[]
  isEdited?: boolean
  editNote?: string
}

type ReportStatus = 'draft' | 'reviewing' | 'confirmed' | 'locked'

const STATUS_CONFIG: Record<ReportStatus, { label: string; color: string }> = {
  draft: { label: '草稿(自动汇总)', color: 'bg-gray-100 text-gray-700' },
  reviewing: { label: '审核中(方圆)', color: 'bg-amber-100 text-amber-700' },
  confirmed: { label: '已确认(Su)', color: 'bg-green-100 text-green-700' },
  locked: { label: '已锁定(不可修改)', color: 'bg-blue-100 text-blue-700' },
}

export default function SupplierReportPage() {
  const [lines, setLines] = useState<SupplierLine[]>([])
  const [allCostDetails, setAllCostDetails] = useState<{ supplier: string; description: string; amount: number; currency: string; cost_type: string; order_no: string; created_at: string }[]>([])
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ReportStatus>('draft')
  const [snapshotId, setSnapshotId] = useState<string | null>(null)
  const [corrections, setCorrections] = useState<Record<string, unknown>[]>([])

  // 修正弹窗
  const [editDialog, setEditDialog] = useState<{ index: number; line: SupplierLine } | null>(null)
  const [editAmount, setEditAmount] = useState('')
  const [editReason, setEditReason] = useState('')
  const [processing, setProcessing] = useState(false)

  useEffect(() => {
    async function load() {
      const supabase = createClient()

      // 先检查是否有已保存的报表快照
      const { data: snapshot } = await supabase
        .from('report_snapshots')
        .select('*')
        .eq('report_type', 'supplier_statement')
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      if (snapshot && snapshot.status !== 'draft') {
        // 有已审核/确认的快照，使用快照数据
        setLines((snapshot.line_items as SupplierLine[]) || [])
        setStatus(snapshot.status as ReportStatus)
        setSnapshotId(snapshot.id)
        setCorrections((snapshot.corrections as Record<string, unknown>[]) || [])
        setLoading(false)
        return
      }

      // 没有快照或是草稿 → 从实时数据自动汇总
      // 加载费用和已付款数据
      const [costRes, payRes] = await Promise.all([
        supabase.from('cost_items').select('id, description, amount, currency, cost_type, supplier, source_module, budget_order_id, created_at, budget_orders(order_no)').order('created_at', { ascending: false }),
        supabase.from('payable_records').select('supplier_name, amount, payment_status').eq('payment_status', 'paid'),
      ])
      const costItems = costRes.data
      const paidRecords = payRes.data

      // 按供应商汇总已付金额（来源1：payable_records + 来源2：cost_items标记为paid）
      const paidMap = new Map<string, number>()
      paidRecords?.forEach(p => {
        const name = p.supplier_name as string
        paidMap.set(name, (paidMap.get(name) || 0) + (p.amount as number || 0))
      })
      // 费用中标记为已付的也算已付
      costItems?.forEach(c => {
        if ((c.source_module as string) === 'paid') {
          const name = (c.supplier as string) || '未指定'
          paidMap.set(name, (paidMap.get(name) || 0) + (c.amount as number || 0))
        }
      })

      if (costItems?.length) {
        // 保存明细（用于导出）
        setAllCostDetails(costItems.map(item => ({
          supplier: (item.supplier as string) || '未指定',
          description: item.description as string,
          amount: item.amount as number,
          currency: (item.currency as string) || 'CNY',
          cost_type: item.cost_type as string,
          order_no: (item.budget_orders as unknown as Record<string, unknown>)?.order_no as string || '',
          created_at: item.created_at as string,
        })))

        // 按供应商汇总
        const supplierMap = new Map<string, { count: number; total: number; paid: number; currency: string; orders: Set<string> }>()

        for (const item of costItems) {
          const supplier = (item.supplier as string) || (item.description as string || '').split(' - ')[0] || '未指定供应商'
          const orderNo = (item.budget_orders as unknown as Record<string, unknown>)?.order_no as string || ''

          const existing = supplierMap.get(supplier) || { count: 0, total: 0, paid: 0, currency: (item.currency as string) || 'CNY', orders: new Set<string>() }
          existing.count++
          existing.total += Number(item.amount) || 0
          existing.paid = paidMap.get(supplier) || 0
          if (orderNo) existing.orders.add(orderNo)
          supplierMap.set(supplier, existing)
        }

        const result: SupplierLine[] = Array.from(supplierMap.entries())
          .map(([supplier, data]) => ({
            supplier,
            count: data.count,
            total: Math.round(data.total * 100) / 100,
            paid: Math.round(data.paid * 100) / 100,
            unpaid: Math.round((data.total - data.paid) * 100) / 100,
            currency: data.currency,
            orders: Array.from(data.orders),
          }))
          .sort((a, b) => b.total - a.total)

        setLines(result)
      }

      setLoading(false)
    }
    load()
  }, [])

  const filtered = lines.filter(s => !search || s.supplier.toLowerCase().includes(search.toLowerCase()))
  const totalAll = filtered.reduce((s, d) => s + d.total, 0)
  const unpaidAll = filtered.reduce((s, d) => s + d.unpaid, 0)
  const isLocked = status === 'locked' || status === 'confirmed'

  // 保存快照
  const saveSnapshot = async (newStatus: ReportStatus) => {
    setProcessing(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    const snapshotData: Record<string, unknown> = {
      report_type: 'supplier_statement',
      report_title: `供应商对账单 ${new Date().toLocaleDateString('zh-CN')}`,
      line_items: lines,
      total_amount: totalAll,
      currency: 'CNY',
      status: newStatus,
      corrections,
      correction_count: corrections.length,
    }

    if (newStatus === 'reviewing') {
      snapshotData.generated_by = user?.id
    }
    if (newStatus === 'confirmed') {
      snapshotData.confirmed_by = user?.id
      snapshotData.confirmed_at = new Date().toISOString()
    }
    if (newStatus === 'reviewing') {
      snapshotData.reviewed_by = user?.id
      snapshotData.reviewed_at = new Date().toISOString()
    }

    if (snapshotId) {
      const { error } = await supabase.from('report_snapshots').update(snapshotData).eq('id', snapshotId)
      if (error) { toast.error(`保存失败: ${error.message}`); setProcessing(false); return }
    } else {
      const { data, error } = await supabase.from('report_snapshots').insert(snapshotData).select('id').single()
      if (error) { toast.error(`保存失败: ${error.message}`); setProcessing(false); return }
      if (data) setSnapshotId(data.id)
    }

    setStatus(newStatus)
    setProcessing(false)

    const labels: Record<string, string> = { reviewing: '已提交审核', confirmed: '已确认', locked: '已锁定' }
    toast.success(labels[newStatus] || '已保存')
  }

  // 修正金额
  const handleCorrection = () => {
    if (!editDialog || !editReason.trim()) { toast.error('请填写修正原因'); return }

    const newLines = [...lines]
    const oldTotal = newLines[editDialog.index].total
    const newTotal = Number(editAmount)

    if (isNaN(newTotal)) { toast.error('请输入有效金额'); return }

    newLines[editDialog.index] = {
      ...newLines[editDialog.index],
      total: newTotal,
      unpaid: newTotal - newLines[editDialog.index].paid,
      isEdited: true,
      editNote: editReason,
    }
    setLines(newLines)

    setCorrections([...corrections, {
      line_index: editDialog.index,
      supplier: editDialog.line.supplier,
      field: 'total',
      old_value: oldTotal,
      new_value: newTotal,
      reason: editReason,
      corrected_by: 'current_user',
      corrected_at: new Date().toISOString(),
    }])

    setEditDialog(null)
    setEditAmount('')
    setEditReason('')
    toast.success('已修正')
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="供应商对账单" subtitle="自动汇总 → 方圆审核 → Su确认 → 锁定导出" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">

        {/* 状态条 */}
        <Card className="border-l-4 border-l-primary">
          <CardContent className="p-3 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Badge className={`${STATUS_CONFIG[status].color} border-0`}>{STATUS_CONFIG[status].label}</Badge>
              {corrections.length > 0 && <Badge variant="secondary" className="text-[10px]">{corrections.length}处修正</Badge>}
              <span className="text-xs text-muted-foreground">{lines.length}个供应商 · 总金额 ¥{totalAll.toLocaleString()}</span>
            </div>
            <div className="flex gap-2">
              {status === 'draft' && (
                <Button size="sm" onClick={() => saveSnapshot('reviewing')} disabled={processing || lines.length === 0}>
                  {processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                  提交审核(方圆)
                </Button>
              )}
              {status === 'reviewing' && (
                <Button size="sm" onClick={() => saveSnapshot('confirmed')} disabled={processing}>
                  {processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                  确认(Su签字)
                </Button>
              )}
              {status === 'confirmed' && (
                <Button size="sm" variant="outline" onClick={() => saveSnapshot('locked')} disabled={processing}>
                  <Lock className="h-4 w-4 mr-1" />锁定
                </Button>
              )}
              {(status === 'confirmed' || status === 'locked') && (
                <Button size="sm" variant="outline" onClick={() => {
                  exportCostSummaryReport(
                    filtered.map(s => ({ category: s.supplier, count: s.count, amount: s.total, currency: s.currency })),
                    { start: '2026-01-01', end: new Date().toISOString().split('T')[0] }
                  )
                  toast.success('已导出')
                }}>
                  <Download className="h-4 w-4 mr-1" />导出
                </Button>
              )}
              {status !== 'draft' && status !== 'locked' && (
                <Button size="sm" variant="ghost" onClick={() => { setStatus('draft'); setSnapshotId(null); toast.info('已退回草稿') }}>
                  退回草稿
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 流程指引 */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={status === 'draft' ? 'text-primary font-medium' : ''}>① 系统自动汇总</span>
          <span>→</span>
          <span className={status === 'reviewing' ? 'text-primary font-medium' : ''}>② 方圆逐笔核对</span>
          <span>→</span>
          <span className={status === 'confirmed' ? 'text-primary font-medium' : ''}>③ Su确认签字</span>
          <span>→</span>
          <span className={status === 'locked' ? 'text-primary font-medium' : ''}>④ 锁定导出</span>
        </div>

        {/* KPI */}
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-blue-50"><FileText className="h-4 w-4 text-blue-600" /></div><div><p className="text-xs text-muted-foreground">供应商数</p><p className="text-xl font-bold">{filtered.length}</p></div></CardContent></Card>
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-green-50"><DollarSign className="h-4 w-4 text-green-600" /></div><div><p className="text-xs text-muted-foreground">总金额</p><p className="text-xl font-bold">¥{totalAll.toLocaleString()}</p></div></CardContent></Card>
          <Card className={unpaidAll > 0 ? 'border-amber-200' : ''}><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-amber-50"><Clock className="h-4 w-4 text-amber-600" /></div><div><p className="text-xs text-muted-foreground">待付金额</p><p className="text-xl font-bold text-amber-600">¥{unpaidAll.toLocaleString()}</p></div></CardContent></Card>
        </div>

        {/* 搜索 */}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="搜索供应商..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        {/* 表格 */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-muted-foreground"><FileText className="h-12 w-12 mx-auto mb-3 opacity-30" /><p>暂无数据</p><p className="text-xs mt-1">请先在费用归集中录入费用</p></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>供应商</TableHead>
                    <TableHead className="text-center">笔数</TableHead>
                    <TableHead className="text-right">总金额</TableHead>
                    <TableHead className="text-right">已付</TableHead>
                    <TableHead className="text-right">待付</TableHead>
                    <TableHead>关联订单</TableHead>
                    <TableHead>状态</TableHead>
                    {!isLocked && <TableHead className="text-center">修正</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((s, i) => {
                    const details = allCostDetails.filter(d => d.supplier === s.supplier)
                    const isExpanded = expandedSupplier === s.supplier
                    return (
                      <React.Fragment key={i}>
                        <TableRow className={`cursor-pointer hover:bg-muted/50 ${s.isEdited ? 'bg-amber-50/50' : ''}`} onClick={() => setExpandedSupplier(isExpanded ? null : s.supplier)}>
                          <TableCell className="font-medium">
                            <span className="mr-1">{isExpanded ? '▼' : '▶'}</span>
                            {s.supplier}
                            {s.isEdited && <Badge variant="secondary" className="ml-1 text-[9px]">已修正</Badge>}
                          </TableCell>
                          <TableCell className="text-center">{s.count}</TableCell>
                          <TableCell className="text-right font-semibold">¥{s.total.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-green-600">¥{s.paid.toLocaleString()}</TableCell>
                          <TableCell className={`text-right font-semibold ${s.unpaid > 0 ? 'text-amber-600' : 'text-green-600'}`}>¥{s.unpaid.toLocaleString()}</TableCell>
                          <TableCell>
                            <div className="flex gap-1 flex-wrap">{s.orders.slice(0, 3).map(o => <Badge key={o} variant="outline" className="text-[10px]">{o}</Badge>)}{s.orders.length > 3 && <span className="text-[10px] text-muted-foreground">+{s.orders.length - 3}</span>}</div>
                          </TableCell>
                          <TableCell><Badge variant={s.unpaid === 0 ? 'default' : 'secondary'} className={s.unpaid === 0 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}>{s.unpaid === 0 ? '已付清' : '未付清'}</Badge></TableCell>
                          {!isLocked && (
                            <TableCell className="text-center" onClick={e => e.stopPropagation()}>
                              <Button size="sm" variant="ghost" className="h-7" onClick={() => { setEditDialog({ index: i, line: s }); setEditAmount(s.total.toString()) }}>
                                <Edit className="h-3.5 w-3.5" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                        {/* 展开的明细行 */}
                        {isExpanded && details.map((d, di) => (
                          <TableRow key={`detail-${di}`} className="bg-muted/30 text-xs">
                            <TableCell className="pl-10 text-muted-foreground">{d.cost_type}</TableCell>
                            <TableCell></TableCell>
                            <TableCell className="text-right">¥{d.amount.toLocaleString()}</TableCell>
                            <TableCell colSpan={2} className="text-muted-foreground">{d.description}</TableCell>
                            <TableCell className="text-muted-foreground">{d.order_no || '-'}</TableCell>
                            <TableCell className="text-muted-foreground">{new Date(d.created_at).toLocaleDateString('zh-CN')}</TableCell>
                            {!isLocked && <TableCell></TableCell>}
                          </TableRow>
                        ))}
                        {isExpanded && (
                          <TableRow className="bg-muted/20">
                            <TableCell colSpan={isLocked ? 7 : 8} className="text-center py-1">
                              <Button size="sm" variant="ghost" className="text-xs h-6" onClick={(e) => {
                                e.stopPropagation()
                                // 导出该供应商明细为CSV
                                const csv = ['供应商,费用类型,描述,金额,币种,关联订单,日期']
                                details.forEach(d => csv.push(`${d.supplier},${d.cost_type},${d.description},${d.amount},${d.currency},${d.order_no},${new Date(d.created_at).toLocaleDateString('zh-CN')}`))
                                const blob = new Blob(['\uFEFF' + csv.join('\n')], { type: 'text/csv;charset=utf-8' })
                                const url = URL.createObjectURL(blob)
                                const a = document.createElement('a')
                                a.href = url; a.download = `${s.supplier}_费用明细.csv`; a.click()
                                URL.revokeObjectURL(url)
                                toast.success(`已导出 ${s.supplier} 的 ${details.length} 条明细`)
                              }}>
                                <Download className="h-3 w-3 mr-1" />导出该供应商明细
                              </Button>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* 修正记录 */}
        {corrections.length > 0 && (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" />修正记录 ({corrections.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {corrections.map((c, i) => (
                <div key={i} className="flex items-center gap-3 text-xs p-2 bg-amber-50 rounded-lg">
                  <span className="font-medium">{c.supplier as string}</span>
                  <span className="text-muted-foreground">¥{(c.old_value as number)?.toLocaleString()} → ¥{(c.new_value as number)?.toLocaleString()}</span>
                  <span className="text-amber-700">原因: {c.reason as string}</span>
                  <span className="text-muted-foreground ml-auto">{new Date(c.corrected_at as string).toLocaleString('zh-CN')}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {/* 修正弹窗 */}
      {editDialog && (
        <Dialog open={true} onOpenChange={() => setEditDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>修正金额 — {editDialog.line.supplier}</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><span className="text-muted-foreground">当前金额: </span><span className="font-semibold">¥{editDialog.line.total.toLocaleString()}</span></div>
                <div><span className="text-muted-foreground">笔数: </span>{editDialog.line.count}</div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">修正后金额 *</p>
                <Input type="number" step="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">修正原因 *</p>
                <Textarea placeholder="例：发票金额有误，按实际对账调整" value={editReason} onChange={e => setEditReason(e.target.value)} rows={2} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditDialog(null)}>取消</Button>
              <Button onClick={handleCorrection}>确认修正</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
