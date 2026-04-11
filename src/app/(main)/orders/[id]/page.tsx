'use client'

import { use, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { BudgetStatusBadge } from '@/components/shared/StatusBadge'
import { FinanceWorkflowGuide } from '@/components/orders/FinanceWorkflowGuide'
import { demoUser } from '@/lib/demo-data'
import { getBudgetOrderById, getSettlementByBudgetId, getApprovalLogs, updateBudgetOrderStatus, createApprovalLog } from '@/lib/supabase/queries'
import { getSubDocuments, getActualInvoices, getShippingDocuments, getOrderSettlement } from '@/lib/supabase/queries-v2'
import type { BudgetOrder, BudgetOrderStatus, ApprovalLog } from '@/lib/types'
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Send,
  FileText,
  Clock,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Loader2,
  Ship,
  Calculator,
  Receipt,
} from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [order, setOrder] = useState<BudgetOrder | null>(null)
  const [settlement, setSettlement] = useState<ReturnType<typeof useState<import('@/lib/types').SettlementOrder | null>>[0]>(null)
  const [logs, setLogs] = useState<ApprovalLog[]>([])
  const [loading, setLoading] = useState(true)
  const [workflowCtx, setWorkflowCtx] = useState({
    hasSubDocs: false, hasInvoices: false, hasShippingDocs: false,
    hasSettlement: false, hasPayables: false, hasCostItems: false,
    invoiceCount: 0, paidCount: 0,
  })
  const [activeTab, setActiveTab] = useState('budget')
  const [syncedInfo, setSyncedInfo] = useState<{ orderNo: string; internalNo: string; quantity: number; quantityUnit: string } | null>(null)
  const [attachments, setAttachments] = useState<{ id: string; file_name: string; file_type: string; file_url: string | null; created_at: string }[]>([])

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const orderData = await getBudgetOrderById(id)
        setOrder(orderData)

        // 加载synced_order关联信息
        const { createClient } = await import('@/lib/supabase/client')
        const supabase = createClient()
        const { data: synced } = await supabase.from('synced_orders').select('order_no, style_no, quantity, quantity_unit').eq('budget_order_id', id).limit(1)
        if (synced?.length) {
          setSyncedInfo({ orderNo: synced[0].order_no as string, internalNo: synced[0].style_no as string || '', quantity: synced[0].quantity as number || 0, quantityUnit: synced[0].quantity_unit as string || '件' })
        }

        // 加载关联附件
        const { data: docs } = await supabase.from('uploaded_documents').select('id, file_name, file_type, file_url, created_at').ilike('matched_order', `%${id}%`).order('created_at', { ascending: false }).limit(20)
        // 也从notes里的QM号查
        const qmNo = synced?.[0]?.order_no
        if (qmNo) {
          const { data: docs2 } = await supabase.from('uploaded_documents').select('id, file_name, file_type, file_url, created_at').or(`file_name.ilike.%${synced[0].style_no}%,file_name.ilike.%${qmNo}%`).order('created_at', { ascending: false }).limit(20)
          const allDocs = [...(docs || []), ...(docs2 || [])]
          const unique = Array.from(new Map(allDocs.map(d => [d.id, d])).values())
          setAttachments(unique as typeof attachments)
        } else if (docs) {
          setAttachments(docs as typeof attachments)
        }

        // 这些查询可能失败（表为空等），不阻塞页面加载
        const [settlementData, logsData, subDocs, invoices, shippingDocs, orderSettlement] = await Promise.all([
          getSettlementByBudgetId(id).catch(() => null),
          getApprovalLogs(id).catch(() => []),
          getSubDocuments(id).catch(() => []),
          getActualInvoices(id).catch(() => []),
          getShippingDocuments(id).catch(() => []),
          getOrderSettlement(id).catch(() => null),
        ])
        setSettlement(settlementData)
        setLogs(logsData as ApprovalLog[])
        setWorkflowCtx({
          hasSubDocs: (subDocs as unknown[])?.length > 0,
          hasInvoices: (invoices as unknown[])?.length > 0,
          hasShippingDocs: (shippingDocs as unknown[])?.length > 0,
          hasSettlement: !!orderSettlement,
          hasPayables: false,
          hasCostItems: false,
          invoiceCount: (invoices as unknown[])?.length || 0,
          paidCount: ((invoices as Record<string, unknown>[]) || []).filter(i => i.status === 'paid').length,
      })
      } catch (e) {
        console.error('订单加载失败:', e)
      }
      setLoading(false)
    }
    load()
  }, [id])
  const [showDialog, setShowDialog] = useState<'approve' | 'reject' | null>(null)
  const [comment, setComment] = useState('')

  // 编辑模式 — 外贸服装成本细分
  const [editMode, setEditMode] = useState(false)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editCurrencyMode, setEditCurrencyMode] = useState<'USD' | 'CNY'>('USD') // 收款币种
  const [editRate, setEditRate] = useState('')       // 结汇汇率
  const [editRevenue, setEditRevenue] = useState('')
  const [editFabric, setEditFabric] = useState('')      // 面料
  const [editAccessory, setEditAccessory] = useState('') // 辅料
  const [editProcessing, setEditProcessing] = useState('')// 加工费
  const [editForwarder, setEditForwarder] = useState('') // 货代费
  const [editContainer, setEditContainer] = useState('') // 装柜费
  const [editLogistics, setEditLogistics] = useState('') // 物流费
  const [editExtras, setEditExtras] = useState<{ name: string; amount: string }[]>([]) // 其他费用

  // 进入编辑模式时预填当前值（从items或现有字段解析）
  useEffect(() => {
    if (editMode && order) {
      setEditRate((order.exchange_rate || 7).toString())
      setEditRevenue(order.total_revenue.toString())
      // 尝试从items中读取细分（之前保存的）
      const breakdown = (order.items as unknown as Record<string, unknown>[])?.[0]
      if (breakdown && breakdown._cost_breakdown) {
        const cb = breakdown._cost_breakdown as Record<string, number | string>
        // 恢复币种模式
        setEditCurrencyMode((cb._currency === 'CNY' && !cb._rate) ? 'CNY' : 'USD')
        setEditFabric((cb.fabric || 0).toString())
        setEditAccessory((cb.accessory || 0).toString())
        setEditProcessing((cb.processing || 0).toString())
        setEditForwarder((cb.forwarder || 0).toString())
        setEditContainer((cb.container || 0).toString())
        setEditLogistics((cb.logistics || 0).toString())
        // 恢复其他费用
        const extras = cb.extras as unknown as { name: string; amount: number }[] | undefined
        setEditExtras(extras?.map(e => ({ name: e.name, amount: (e.amount || 0).toString() })) || [])
      } else {
        setEditFabric(order.target_purchase_price.toString())
        setEditAccessory('0')
        setEditProcessing(order.estimated_commission.toString())
        setEditForwarder(order.estimated_freight.toString())
        setEditContainer(order.estimated_customs_fee.toString())
        setEditLogistics(order.other_costs.toString())
        setEditExtras([])
      }
    }
  }, [editMode, order])

  const handleSaveEdit = async () => {
    if (!order) return
    setSavingEdit(true)
    const revenueInput = Number(editRevenue) || 0
    const rate = editCurrencyMode === 'CNY' ? 1 : (Number(editRate) || order.exchange_rate || 7)
    const revenueCny = editCurrencyMode === 'CNY' ? revenueInput : revenueInput * rate
    const revenueUsd = editCurrencyMode === 'CNY' ? revenueInput : revenueInput // DB stores the input value
    const fabric = Number(editFabric) || 0
    const accessory = Number(editAccessory) || 0
    const processing = Number(editProcessing) || 0
    const forwarder = Number(editForwarder) || 0
    const container = Number(editContainer) || 0
    const logistics = Number(editLogistics) || 0
    const extrasTotal = editExtras.reduce((s, e) => s + (Number(e.amount) || 0), 0)
    const totalCostCny = fabric + accessory + processing + forwarder + container + logistics + extrasTotal
    const profitCny = revenueCny - totalCostCny
    const margin = revenueCny > 0 ? Math.round((profitCny / revenueCny) * 10000) / 100 : 0
    // 映射到数据库字段
    const purchase = fabric + accessory  // 面料+辅料合并到采购价
    const freight = forwarder            // 货代费→运费字段
    const commission = processing        // 加工费→佣金字段
    const customs = container            // 装柜费→报关费字段
    const other = logistics + extrasTotal // 物流费+其他→其他费用字段

    try {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const extrasData = editExtras.filter(e => e.name && Number(e.amount)).map(e => ({ name: e.name, amount: Number(e.amount) || 0 }))
      const breakdownData = { fabric, accessory, processing, forwarder, container, logistics, extras: extrasData, _currency: editCurrencyMode === 'CNY' ? 'CNY_DIRECT' : 'CNY', _revenue_input: revenueInput, _revenue_currency: editCurrencyMode, _rate: rate }
      // 保留原有产品明细，将cost breakdown存入第一个item或单独追加
      const existingItems = (order.items || []) as unknown as Record<string, unknown>[]
      const updatedItems = existingItems.length > 0
        ? [{ ...existingItems[0], _cost_breakdown: breakdownData }, ...existingItems.slice(1)]
        : [{ _cost_breakdown: breakdownData }]
      const { error } = await supabase.from('budget_orders').update({
        total_revenue: revenueInput,
        currency: editCurrencyMode === 'CNY' ? 'CNY' : 'USD',
        exchange_rate: rate,
        target_purchase_price: purchase,
        estimated_freight: freight,
        estimated_commission: commission,
        estimated_customs_fee: customs,
        other_costs: other,
        total_cost: totalCostCny,
        estimated_profit: profitCny,
        estimated_margin: margin,
        items: updatedItems,
      }).eq('id', order.id).eq('version', order.version || 1)

      if (error) {
        if (error.message.includes('已审批')) {
          toast.error('已审批的订单不能修改金额，如需修改请先撤回审批')
        } else {
          toast.error('保存失败: ' + error.message)
        }
      } else {
        setOrder({ ...order, total_revenue: revenueInput, currency: editCurrencyMode === 'CNY' ? 'CNY' : 'USD', exchange_rate: rate, target_purchase_price: purchase, estimated_freight: freight, estimated_commission: commission, estimated_customs_fee: customs, other_costs: other, total_cost: totalCostCny, estimated_profit: profitCny, estimated_margin: margin, version: (order.version || 1) + 1, items: updatedItems as unknown as typeof order.items })
        setEditMode(false)
        toast.success('预算已保存')
      }
    } catch { toast.error('保存失败') }
    setSavingEdit(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">订单未找到</p>
      </div>
    )
  }

  const handleStatusChange = async (action: 'submit' | 'approve' | 'reject', newStatus: BudgetOrderStatus) => {
    // 自审批阻止：审批人不能是创建人
    if (action === 'approve' && demoUser.id === order.created_by) {
      toast.error('不能审批自己创建的订单')
      return
    }

    // 1. 持久化状态变更到数据库
    const { error: statusError } = await updateBudgetOrderStatus(order.id, newStatus, demoUser.id)
    if (statusError) {
      toast.error(`操作失败: ${statusError}`)
      return
    }

    // 2. 持久化审批记录
    const log: ApprovalLog = {
      id: `al-${Date.now()}`,
      entity_type: 'budget_order',
      entity_id: order.id,
      action,
      from_status: order.status,
      to_status: newStatus,
      operator_id: demoUser.id,
      operator: demoUser,
      comment: comment || null,
      created_at: new Date().toISOString(),
    }
    await createApprovalLog(log)

    // 3. 更新UI
    setOrder({ ...order, status: newStatus })
    setLogs([...logs, log])
    setComment('')
    setShowDialog(null)

    const actionLabels = { submit: '提交审批', approve: '审批通过', reject: '审批驳回' }
    toast.success(actionLabels[action], { description: `订单 ${order.order_no} 已${actionLabels[action]}` })
  }

  const handleGenerateSettlement = () => {
    toast.success('结算单已生成', { description: `基于预算单 ${order.order_no} 生成结算单` })
    router.push('/orders')
  }

  const varianceData = settlement?.variance_analysis?.map((v) => ({
    name: v.category,
    budgeted: v.budgeted,
    actual: v.actual,
    variance: v.variance,
  })) || []

  return (
    <div className="flex flex-col h-full">
      <Header
        title={order.order_no}
        subtitle={`${order.customer?.company} · ${order.currency}`}
      />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* Top Actions */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Link href="/orders">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              返回列表
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <BudgetStatusBadge status={order.status} />
            {order.status === 'draft' && (
              <Button size="sm" onClick={() => handleStatusChange('submit', 'pending_review')}>
                <Send className="h-4 w-4 mr-1" />
                提交审批
              </Button>
            )}
            {order.status === 'pending_review' && (
              <>
                <Button size="sm" variant="default" onClick={() => setShowDialog('approve')}>
                  <CheckCircle className="h-4 w-4 mr-1" />
                  通过
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setShowDialog('reject')}>
                  <XCircle className="h-4 w-4 mr-1" />
                  驳回
                </Button>
              </>
            )}
            {order.status === 'approved' && !settlement && (
              <Button size="sm" variant="outline" onClick={handleGenerateSettlement}>
                <FileText className="h-4 w-4 mr-1" />
                生成结算单
              </Button>
            )}
          </div>
        </div>

        {/* 财务流程引导 */}
        <FinanceWorkflowGuide order={order} context={workflowCtx} onNavigate={setActiveTab} />

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="budget">预算单详情</TabsTrigger>
            <TabsTrigger value="settlement" disabled={!settlement}>
              结算单 {settlement && <Badge variant="secondary" className="ml-1 text-[10px]">已生成</Badge>}
            </TabsTrigger>
            <TabsTrigger value="variance" disabled={!settlement}>差异分析</TabsTrigger>
            <TabsTrigger value="approval">审批记录 ({logs.length})</TabsTrigger>
          </TabsList>

          {/* Budget Tab */}
          <TabsContent value="budget" className="space-y-4 mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">基本信息</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {syncedInfo && (
                    <>
                      <div className="flex justify-between"><span className="text-muted-foreground">内部单号</span><span className="font-bold text-primary">{syncedInfo.internalNo}</span></div>
                      <div className="flex justify-between"><span className="text-muted-foreground">节拍器号</span><span className="font-mono text-xs">{syncedInfo.orderNo}</span></div>
                      {syncedInfo.quantity > 0 && <div className="flex justify-between"><span className="text-muted-foreground">数量</span><span className="font-medium">{syncedInfo.quantity.toLocaleString()} {syncedInfo.quantityUnit}</span></div>}
                      <Separator />
                    </>
                  )}
                  <div className="flex justify-between"><span className="text-muted-foreground">客户</span><span className="font-medium">{order.customer?.company}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">国家</span><span>{order.customer?.country}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">下单日期</span><span>{order.order_date}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">交货日期</span><span>{order.delivery_date || '-'}</span></div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">成本构成</CardTitle>
                    {(order.status === 'draft' || order.status === 'rejected') && !editMode && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditMode(true)}>编辑</Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {editMode ? (
                    (() => {
                      const rate = editCurrencyMode === 'CNY' ? 1 : (Number(editRate) || order.exchange_rate || 7)
                      const revenueInput = Number(editRevenue) || 0
                      const revenueCny = editCurrencyMode === 'CNY' ? revenueInput : revenueInput * rate
                      const costTotal = [editFabric, editAccessory, editProcessing, editForwarder, editContainer, editLogistics].reduce((s, v) => s + (Number(v) || 0), 0) + editExtras.reduce((s, e) => s + (Number(e.amount) || 0), 0)
                      const profitCny = revenueCny - costTotal
                      const marginPct = revenueCny > 0 ? (profitCny / revenueCny * 100).toFixed(1) : '0'
                      return <div className="space-y-3">
                        {/* 收款币种选择 */}
                        <div className="space-y-1">
                          <Label className="text-xs font-semibold">客户付款币种</Label>
                          <div className="grid grid-cols-2 gap-2">
                            <Button type="button" size="sm" variant={editCurrencyMode === 'USD' ? 'default' : 'outline'} className="text-xs" onClick={() => setEditCurrencyMode('USD')}>
                              $ 美金（需结汇）
                            </Button>
                            <Button type="button" size="sm" variant={editCurrencyMode === 'CNY' ? 'default' : 'outline'} className="text-xs" onClick={() => setEditCurrencyMode('CNY')}>
                              ¥ 人民币（直收）
                            </Button>
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs font-semibold text-primary">合同金额 ({editCurrencyMode === 'CNY' ? 'CNY' : 'USD'})</Label>
                          <Input type="number" step="0.01" value={editRevenue} onChange={e => setEditRevenue(e.target.value)} className="border-primary/30" />
                        </div>
                        {editCurrencyMode === 'USD' && (
                          <div className="space-y-1">
                            <Label className="text-xs font-semibold text-amber-600">结汇汇率</Label>
                            <Input type="number" step="0.01" value={editRate} onChange={e => setEditRate(e.target.value)} className="border-amber-300" />
                            <p className="text-[10px] text-muted-foreground">折合人民币 ¥{revenueCny.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                          </div>
                        )}
                        <Separator />
                        <p className="text-[10px] text-muted-foreground font-medium">成本明细 (CNY 人民币)</p>
                        <div className="space-y-1"><Label className="text-xs">面料 (¥)</Label><Input type="number" step="0.01" value={editFabric} onChange={e => setEditFabric(e.target.value)} /></div>
                        <div className="space-y-1"><Label className="text-xs">辅料 (¥)</Label><Input type="number" step="0.01" value={editAccessory} onChange={e => setEditAccessory(e.target.value)} /></div>
                        <div className="space-y-1"><Label className="text-xs">加工费 (¥)</Label><Input type="number" step="0.01" value={editProcessing} onChange={e => setEditProcessing(e.target.value)} /></div>
                        <div className="space-y-1"><Label className="text-xs">货代费 (¥)</Label><Input type="number" step="0.01" value={editForwarder} onChange={e => setEditForwarder(e.target.value)} /></div>
                        <div className="space-y-1"><Label className="text-xs">装柜费 (¥)</Label><Input type="number" step="0.01" value={editContainer} onChange={e => setEditContainer(e.target.value)} /></div>
                        <div className="space-y-1"><Label className="text-xs">物流费 (¥)</Label><Input type="number" step="0.01" value={editLogistics} onChange={e => setEditLogistics(e.target.value)} /></div>
                        {/* 其他费用（可自定义名称） */}
                        {editExtras.map((extra, idx) => (
                          <div key={idx} className="flex gap-2 items-end">
                            <div className="flex-1 space-y-1">
                              <Input placeholder="费用名称（如佣金）" value={extra.name} onChange={e => { const n = [...editExtras]; n[idx] = { ...n[idx], name: e.target.value }; setEditExtras(n) }} className="text-xs h-8" />
                            </div>
                            <div className="w-28 space-y-1">
                              <Input type="number" step="0.01" placeholder="¥" value={extra.amount} onChange={e => { const n = [...editExtras]; n[idx] = { ...n[idx], amount: e.target.value }; setEditExtras(n) }} className="text-xs h-8" />
                            </div>
                            <Button type="button" size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-400 hover:text-red-600" onClick={() => setEditExtras(editExtras.filter((_, i) => i !== idx))}>×</Button>
                          </div>
                        ))}
                        <Button type="button" size="sm" variant="outline" className="w-full text-xs h-7" onClick={() => setEditExtras([...editExtras, { name: '', amount: '' }])}>
                          + 添加其他费用
                        </Button>
                        <Separator />
                        <div className="p-2 rounded-lg bg-muted text-xs space-y-1">
                          <div className="flex justify-between"><span>成本合计</span><span className="font-medium">¥{costTotal.toLocaleString()}</span></div>
                          <div className="flex justify-between"><span>预计利润</span><span className={`font-semibold ${profitCny < 0 ? 'text-red-600' : 'text-green-600'}`}>¥{profitCny.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>
                          <div className="flex justify-between"><span>毛利率</span><span className={`font-medium ${Number(marginPct) < 15 ? 'text-amber-600' : 'text-green-600'}`}>{marginPct}%</span></div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" className="flex-1" disabled={savingEdit} onClick={handleSaveEdit}>
                            {savingEdit ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}保存
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditMode(false)}>取消</Button>
                        </div>
                      </div>
                    })()
                  ) : (
                    (() => {
                      const bd = (order.items as unknown as Record<string, unknown>[])?.[0]
                      const cb = bd?._cost_breakdown as Record<string, number | string> | undefined
                      const isCnyDirect = order.currency === 'CNY' || cb?._revenue_currency === 'CNY'
                      const rate = isCnyDirect ? 1 : (order.exchange_rate || 1)
                      const revenueCny = isCnyDirect ? order.total_revenue : order.total_revenue * rate
                      return <>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">合同金额</span>
                          <span className="font-medium">{isCnyDirect ? '¥' : '$'} {order.total_revenue.toLocaleString()}</span>
                        </div>
                        {!isCnyDirect && (
                          <div className="flex justify-between"><span className="text-muted-foreground">汇率 {rate} 结汇</span><span className="font-medium text-primary">¥ {revenueCny.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span></div>
                        )}
                        {isCnyDirect && (
                          <div className="flex justify-between"><span className="text-muted-foreground">收款方式</span><span className="font-medium text-green-600">人民币直收</span></div>
                        )}
                        <Separator />
                        <p className="text-[10px] text-muted-foreground font-medium">成本明细 (CNY)</p>
                        <div className="flex justify-between"><span className="text-muted-foreground">面料</span><span className="font-medium">¥ {(cb?.fabric ?? order.target_purchase_price).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">辅料</span><span>¥ {(cb?.accessory ?? 0).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">加工费</span><span>¥ {(cb?.processing ?? order.estimated_commission).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">货代费</span><span>¥ {(cb?.forwarder ?? order.estimated_freight).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">装柜费</span><span>¥ {(cb?.container ?? order.estimated_customs_fee).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">物流费</span><span>¥ {(cb?.logistics ?? order.other_costs).toLocaleString()}</span></div>
                        {(cb?.extras as unknown as { name: string; amount: number }[] | undefined)?.map((e, i) => (
                          <div key={i} className="flex justify-between"><span className="text-muted-foreground">{e.name}</span><span>¥ {e.amount.toLocaleString()}</span></div>
                        ))}
                        <Separator />
                        <div className="flex justify-between font-semibold"><span>成本合计</span><span>¥ {order.total_cost.toLocaleString()}</span></div>
                      </>
                    })()
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">利润概览</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <p className="text-sm text-muted-foreground mb-1">预计利润 (CNY)</p>
                    <p className={`text-3xl font-bold ${order.estimated_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      ¥ {order.estimated_profit.toLocaleString()}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="text-center p-3 rounded-lg bg-blue-50">
                      <p className="text-xs text-muted-foreground">合同金额</p>
                      <p className="text-sm font-semibold text-blue-700">{order.currency === 'CNY' ? '¥' : '$'} {order.total_revenue.toLocaleString()}</p>
                    </div>
                    <div className="text-center p-3 rounded-lg bg-amber-50">
                      <p className="text-xs text-muted-foreground">毛利率</p>
                      <p className={`text-sm font-semibold ${order.estimated_margin < 0 ? 'text-red-700' : order.estimated_margin < 15 ? 'text-amber-700' : 'text-green-700'}`}>
                        {order.estimated_margin}%
                      </p>
                    </div>
                  </div>
                  {order.estimated_margin < 15 && order.estimated_margin >= 0 && (
                    <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-50 text-amber-700 text-xs" role="alert">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>毛利率低于15%警戒线</span>
                    </div>
                  )}
                  {order.estimated_margin < 0 && (
                    <div className="flex items-center gap-2 p-2 rounded-lg bg-red-50 text-red-700 text-xs" role="alert">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>预计亏损，请谨慎评估</span>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* 快捷操作入口 */}
            {order.status === 'approved' && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Link href={`/orders/${order.id}/shipping`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer border-blue-200 hover:border-blue-400">
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-blue-50"><Ship className="h-5 w-5 text-blue-600" /></div>
                      <div><p className="text-sm font-medium">出货管理</p><p className="text-xs text-muted-foreground">PI/CI/装箱单/报关</p></div>
                    </CardContent>
                  </Card>
                </Link>
                <Link href={`/orders/${order.id}/settlement`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer border-green-200 hover:border-green-400">
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-green-50"><Calculator className="h-5 w-5 text-green-600" /></div>
                      <div><p className="text-sm font-medium">订单决算</p><p className="text-xs text-muted-foreground">实际成本 vs 预算</p></div>
                    </CardContent>
                  </Card>
                </Link>
                <Link href="/payments">
                  <Card className="hover:shadow-md transition-shadow cursor-pointer border-amber-200 hover:border-amber-400">
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-amber-50"><Receipt className="h-5 w-5 text-amber-600" /></div>
                      <div><p className="text-sm font-medium">应付管理</p><p className="text-xs text-muted-foreground">付款审批与执行</p></div>
                    </CardContent>
                  </Card>
                </Link>
              </div>
            )}

            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm">产品明细</CardTitle></CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>产品名称</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead>单位</TableHead>
                      <TableHead className="text-right">单价</TableHead>
                      <TableHead className="text-right">金额</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {order.items.filter(item => item.sku || item.product_name).map((item, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-sm">{item.sku || '-'}</TableCell>
                        <TableCell>{item.product_name || '-'}</TableCell>
                        <TableCell className="text-right">{(item.qty || 0).toLocaleString()}</TableCell>
                        <TableCell>{item.unit || '-'}</TableCell>
                        <TableCell className="text-right">{order.currency} {(item.unit_price || 0).toFixed(2)}</TableCell>
                        <TableCell className="text-right font-medium">{order.currency} {(item.amount || 0).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold bg-muted/50">
                      <TableCell colSpan={5} className="text-right">合计</TableCell>
                      <TableCell className="text-right">{order.currency === 'CNY' ? '¥' : '$'} {order.total_revenue.toLocaleString()}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* 附件区域 */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">订单附件</CardTitle>
                  <Link href="/documents">
                    <Button size="sm" variant="outline" className="h-7 text-xs">上传附件</Button>
                  </Link>
                </div>
              </CardHeader>
              <CardContent>
                {attachments.length > 0 ? (
                  <div className="space-y-2">
                    {attachments.map(doc => (
                      <div key={doc.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{doc.file_name}</p>
                            <p className="text-[10px] text-muted-foreground">{new Date(doc.created_at).toLocaleDateString('zh-CN')}</p>
                          </div>
                        </div>
                        <Link href={`/documents/${doc.id}`}>
                          <Button size="sm" variant="ghost" className="h-7 text-xs">查看</Button>
                        </Link>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-sm text-muted-foreground py-4">暂无附件，可在文档中心上传PO、成本核算单等</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Settlement Tab */}
          <TabsContent value="settlement" className="space-y-4 mt-4">
            {settlement && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-sm">实际成本</CardTitle></CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="flex justify-between"><span className="text-muted-foreground">实际采购成本</span><span className="font-medium">{order.currency} {settlement.actual_purchase_cost.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">实际运费</span><span>{order.currency} {settlement.actual_freight.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">实际佣金</span><span>{order.currency} {settlement.actual_commission.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">实际报关费</span><span>{order.currency} {settlement.actual_customs_fee.toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">其他实际费用</span><span>{order.currency} {settlement.other_actual_costs.toLocaleString()}</span></div>
                    <Separator />
                    <div className="flex justify-between font-semibold"><span>实际总成本</span><span>{order.currency} {settlement.total_actual_cost.toLocaleString()}</span></div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-sm">实际利润</CardTitle></CardHeader>
                  <CardContent className="space-y-4">
                    <div className="text-center p-4 rounded-lg bg-muted">
                      <p className="text-sm text-muted-foreground mb-1">实际利润</p>
                      <p className={`text-3xl font-bold ${settlement.actual_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {order.currency} {settlement.actual_profit.toLocaleString()}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="text-center p-3 rounded-lg bg-blue-50"><p className="text-xs text-muted-foreground">实际收入</p><p className="text-sm font-semibold text-blue-700">{order.currency} {settlement.actual_revenue.toLocaleString()}</p></div>
                      <div className="text-center p-3 rounded-lg bg-amber-50"><p className="text-xs text-muted-foreground">实际毛利率</p><p className={`text-sm font-semibold ${settlement.actual_margin < 0 ? 'text-red-700' : 'text-green-700'}`}>{settlement.actual_margin}%</p></div>
                    </div>
                    <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${settlement.variance_amount < 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`} role="alert">
                      {settlement.variance_amount < 0 ? <TrendingDown className="h-4 w-4" aria-hidden="true" /> : <TrendingUp className="h-4 w-4" aria-hidden="true" />}
                      <span>利润偏差: {order.currency} {settlement.variance_amount.toLocaleString()} ({settlement.variance_percentage}%)</span>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          {/* Variance Tab */}
          <TabsContent value="variance" className="space-y-4 mt-4">
            {settlement && varianceData.length > 0 && (
              <>
                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-sm">预算 vs 实际对比图</CardTitle></CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={varianceData} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                        <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} />
                        <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 12 }} />
                        <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                        <Bar dataKey="budgeted" name="预算" fill="#93c5fd" radius={[0, 4, 4, 0]} />
                        <Bar dataKey="actual" name="实际" radius={[0, 4, 4, 0]}>
                          {varianceData.map((entry, index) => (
                            <Cell key={index} fill={entry.variance > 0 ? '#fca5a5' : '#86efac'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3"><CardTitle className="text-sm">差异明细</CardTitle></CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>费用类别</TableHead>
                          <TableHead className="text-right">预算金额</TableHead>
                          <TableHead className="text-right">实际金额</TableHead>
                          <TableHead className="text-right">差异</TableHead>
                          <TableHead className="text-right">差异率</TableHead>
                          <TableHead>说明</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {settlement.variance_analysis?.map((v, idx) => (
                          <TableRow key={idx}>
                            <TableCell className="font-medium">{v.category}</TableCell>
                            <TableCell className="text-right">{order.currency} {v.budgeted.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{order.currency} {v.actual.toLocaleString()}</TableCell>
                            <TableCell className={`text-right font-semibold ${v.variance > 0 ? 'text-red-600' : v.variance < 0 ? 'text-green-600' : ''}`}>
                              {v.variance > 0 ? '+' : ''}{order.currency} {v.variance.toLocaleString()}
                            </TableCell>
                            <TableCell className={`text-right ${v.percentage > 0 ? 'text-red-600' : v.percentage < 0 ? 'text-green-600' : ''}`}>
                              {v.percentage > 0 ? '+' : ''}{v.percentage}%
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground max-w-[200px]">{v.explanation || '-'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          {/* Approval Tab */}
          <TabsContent value="approval" className="space-y-4 mt-4">
            <Card>
              <CardContent className="pt-6">
                {logs.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">暂无审批记录</p>
                ) : (
                  <div className="space-y-4">
                    {logs.map((log) => (
                      <div key={log.id} className="flex gap-4">
                        <div className="flex flex-col items-center">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                            log.action === 'approve' ? 'bg-green-100 text-green-600' : log.action === 'reject' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'
                          }`}>
                            {log.action === 'approve' ? <CheckCircle className="h-4 w-4" /> : log.action === 'reject' ? <XCircle className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                          </div>
                          <div className="w-px flex-1 bg-border mt-2" />
                        </div>
                        <div className="pb-6">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{log.operator?.name || '系统'}</span>
                            <span className="text-sm text-muted-foreground">
                              {log.action === 'submit' ? '提交审批' : log.action === 'approve' ? '审批通过' : log.action === 'reject' ? '审批驳回' : '撤回'}
                            </span>
                          </div>
                          {log.comment && <p className="text-sm text-muted-foreground mt-1">{log.comment}</p>}
                          <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" aria-hidden="true" />
                            <span>{new Date(log.created_at).toLocaleString('zh-CN')}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Approve/Reject Dialog */}
      <Dialog open={showDialog !== null} onOpenChange={() => setShowDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{showDialog === 'approve' ? '审批通过' : '审批驳回'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-sm">
              <span className="text-muted-foreground">订单: </span>
              <span className="font-medium">{order.order_no}</span>
              <span className="text-muted-foreground ml-4">金额: </span>
              <span className="font-medium">{order.currency} {order.total_revenue.toLocaleString()}</span>
            </div>
            <Textarea
              placeholder={showDialog === 'approve' ? '审批意见（选填）' : '驳回原因（建议填写）'}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(null)}>取消</Button>
            {showDialog === 'approve' ? (
              <Button onClick={() => handleStatusChange('approve', 'approved')}>
                <CheckCircle className="h-4 w-4 mr-1" />确认通过
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => handleStatusChange('reject', 'rejected')}>
                <XCircle className="h-4 w-4 mr-1" />确认驳回
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
