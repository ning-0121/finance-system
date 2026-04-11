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

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const orderData = await getBudgetOrderById(id)
        setOrder(orderData)

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
  const [editRevenue, setEditRevenue] = useState('')
  const [editFabric, setEditFabric] = useState('')      // 面料
  const [editAccessory, setEditAccessory] = useState('') // 辅料
  const [editProcessing, setEditProcessing] = useState('')// 加工费
  const [editForwarder, setEditForwarder] = useState('') // 货代费
  const [editContainer, setEditContainer] = useState('') // 装柜费
  const [editLogistics, setEditLogistics] = useState('') // 物流费

  // 进入编辑模式时预填当前值（从items或现有字段解析）
  useEffect(() => {
    if (editMode && order) {
      setEditRevenue(order.total_revenue.toString())
      // 尝试从items中读取细分（之前保存的）
      const breakdown = (order.items as unknown as Record<string, unknown>[])?.[0]
      if (breakdown && breakdown._cost_breakdown) {
        const cb = breakdown._cost_breakdown as Record<string, number>
        setEditFabric((cb.fabric || 0).toString())
        setEditAccessory((cb.accessory || 0).toString())
        setEditProcessing((cb.processing || 0).toString())
        setEditForwarder((cb.forwarder || 0).toString())
        setEditContainer((cb.container || 0).toString())
        setEditLogistics((cb.logistics || 0).toString())
      } else {
        // 从现有字段映射
        setEditFabric(order.target_purchase_price.toString())
        setEditAccessory('0')
        setEditProcessing(order.estimated_commission.toString())
        setEditForwarder(order.estimated_freight.toString())
        setEditContainer(order.estimated_customs_fee.toString())
        setEditLogistics(order.other_costs.toString())
      }
    }
  }, [editMode, order])

  const handleSaveEdit = async () => {
    if (!order) return
    setSavingEdit(true)
    const revenue = Number(editRevenue) || 0
    const fabric = Number(editFabric) || 0
    const accessory = Number(editAccessory) || 0
    const processing = Number(editProcessing) || 0
    const forwarder = Number(editForwarder) || 0
    const container = Number(editContainer) || 0
    const logistics = Number(editLogistics) || 0
    const totalCost = fabric + accessory + processing + forwarder + container + logistics
    const profit = revenue - totalCost
    const margin = revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : 0
    // 映射到数据库字段
    const purchase = fabric + accessory  // 面料+辅料合并到采购价
    const freight = forwarder            // 货代费→运费字段
    const commission = processing        // 加工费→佣金字段
    const customs = container            // 装柜费→报关费字段
    const other = logistics              // 物流费→其他费用字段

    try {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const costBreakdown = { _cost_breakdown: { fabric, accessory, processing, forwarder, container, logistics } }
      const { error } = await supabase.from('budget_orders').update({
        total_revenue: revenue,
        target_purchase_price: purchase,
        estimated_freight: freight,
        estimated_commission: commission,
        estimated_customs_fee: customs,
        other_costs: other,
        total_cost: totalCost,
        estimated_profit: profit,
        estimated_margin: margin,
        items: [costBreakdown], // 保存细分明细
      }).eq('id', order.id)

      if (error) { toast.error('保存失败: ' + error.message) }
      else {
        setOrder({ ...order, total_revenue: revenue, target_purchase_price: purchase, estimated_freight: freight, estimated_commission: commission, estimated_customs_fee: customs, other_costs: other, total_cost: totalCost, estimated_profit: profit, estimated_margin: margin })
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
                  <div className="flex justify-between"><span className="text-muted-foreground">客户</span><span className="font-medium">{order.customer?.company}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">国家</span><span>{order.customer?.country}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">下单日期</span><span>{order.order_date}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">交货日期</span><span>{order.delivery_date || '-'}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">币种</span><span>{order.currency}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">汇率</span><span>{order.exchange_rate}</span></div>
                  {order.notes && (
                    <>
                      <Separator />
                      <div><span className="text-muted-foreground">备注</span><p className="mt-1">{order.notes}</p></div>
                    </>
                  )}
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
                    <div className="space-y-3">
                      <div className="space-y-1"><Label className="text-xs font-semibold text-primary">总收入 ({order.currency})</Label><Input type="number" step="0.01" value={editRevenue} onChange={e => setEditRevenue(e.target.value)} className="border-primary/30" /></div>
                      <Separator />
                      <p className="text-[10px] text-muted-foreground font-medium">成本明细</p>
                      <div className="space-y-1"><Label className="text-xs">面料 ({order.currency})</Label><Input type="number" step="0.01" value={editFabric} onChange={e => setEditFabric(e.target.value)} /></div>
                      <div className="space-y-1"><Label className="text-xs">辅料 ({order.currency})</Label><Input type="number" step="0.01" value={editAccessory} onChange={e => setEditAccessory(e.target.value)} /></div>
                      <div className="space-y-1"><Label className="text-xs">加工费 ({order.currency})</Label><Input type="number" step="0.01" value={editProcessing} onChange={e => setEditProcessing(e.target.value)} /></div>
                      <div className="space-y-1"><Label className="text-xs">货代费 ({order.currency})</Label><Input type="number" step="0.01" value={editForwarder} onChange={e => setEditForwarder(e.target.value)} /></div>
                      <div className="space-y-1"><Label className="text-xs">装柜费 ({order.currency})</Label><Input type="number" step="0.01" value={editContainer} onChange={e => setEditContainer(e.target.value)} /></div>
                      <div className="space-y-1"><Label className="text-xs">物流费 ({order.currency})</Label><Input type="number" step="0.01" value={editLogistics} onChange={e => setEditLogistics(e.target.value)} /></div>
                      <Separator />
                      <div className="flex gap-2">
                        <Button size="sm" className="flex-1" disabled={savingEdit} onClick={handleSaveEdit}>
                          {savingEdit ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}保存
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditMode(false)}>取消</Button>
                      </div>
                    </div>
                  ) : (
                    (() => {
                      const bd = (order.items as unknown as Record<string, unknown>[])?.[0]
                      const cb = bd?._cost_breakdown as Record<string, number> | undefined
                      return <>
                        <div className="flex justify-between"><span className="text-muted-foreground">面料</span><span className="font-medium">{order.currency} {(cb?.fabric ?? order.target_purchase_price).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">辅料</span><span>{order.currency} {(cb?.accessory ?? 0).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">加工费</span><span>{order.currency} {(cb?.processing ?? order.estimated_commission).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">货代费</span><span>{order.currency} {(cb?.forwarder ?? order.estimated_freight).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">装柜费</span><span>{order.currency} {(cb?.container ?? order.estimated_customs_fee).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">物流费</span><span>{order.currency} {(cb?.logistics ?? order.other_costs).toLocaleString()}</span></div>
                        <Separator />
                        <div className="flex justify-between font-semibold"><span>总成本</span><span>{order.currency} {order.total_cost.toLocaleString()}</span></div>
                      </>
                    })()
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">利润概览</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-center p-4 rounded-lg bg-muted">
                    <p className="text-sm text-muted-foreground mb-1">预计利润</p>
                    <p className={`text-3xl font-bold ${order.estimated_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {order.currency} {order.estimated_profit.toLocaleString()}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="text-center p-3 rounded-lg bg-blue-50">
                      <p className="text-xs text-muted-foreground">总收入</p>
                      <p className="text-sm font-semibold text-blue-700">{order.currency} {order.total_revenue.toLocaleString()}</p>
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
                    {order.items.map((item, idx) => (
                      <TableRow key={idx}>
                        <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                        <TableCell>{item.product_name}</TableCell>
                        <TableCell className="text-right">{item.qty.toLocaleString()}</TableCell>
                        <TableCell>{item.unit}</TableCell>
                        <TableCell className="text-right">{order.currency} {item.unit_price.toFixed(2)}</TableCell>
                        <TableCell className="text-right font-medium">{order.currency} {item.amount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="font-semibold bg-muted/50">
                      <TableCell colSpan={5} className="text-right">合计</TableCell>
                      <TableCell className="text-right">{order.currency} {order.total_revenue.toLocaleString()}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
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
