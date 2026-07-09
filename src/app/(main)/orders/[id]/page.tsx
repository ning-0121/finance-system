'use client'

import { use, useState, useEffect, useMemo } from 'react'
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
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import { getBudgetOrderById, getSettlementByBudgetId, getApprovalLogs, updateBudgetOrderStatus, createApprovalLog } from '@/lib/supabase/queries'
import { generateOrderSettlement } from '@/lib/supabase/queries-v2'
import { validateBudgetEdit } from '@/lib/engines/validation-engine'
import { runOrderSubmitGate, type GateResult } from '@/lib/engines/submit-gate-engine'
import { getSubDocuments, getActualInvoices, getShippingDocuments, getOrderSettlement } from '@/lib/supabase/queries-v2'
import type { BudgetOrder, BudgetOrderStatus, ApprovalLog, OrderSettlement } from '@/lib/types'
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
  LineChart,
  Download,
} from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { exportBudgetOrSettlementToExcel, synthesizeCostItems } from '@/lib/excel/export-budget-sheet'
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
  const { user } = useCurrentUser()

  const [order, setOrder] = useState<BudgetOrder | null>(null)
  const [settlement, setSettlement] = useState<ReturnType<typeof useState<import('@/lib/types').SettlementOrder | null>>[0]>(null)
  const [orderSettlement, setOrderSettlementState] = useState<OrderSettlement | null>(null)  // 新版决算（order_settlements 表）
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
  // 费用归集（cost_items）实际明细：预算未录明细时回退展示公斤数/单价，供核对
  const [costDetail, setCostDetail] = useState<Record<string, { name: string; qty: number; unit: string; unit_price: number; amount: number }[]>>({})

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

        // 加载费用归集明细（含公斤数/单价）→ 预算未录明细时按类别回退展示，供财务核对
        const { data: ci } = await supabase
          .from('cost_items')
          .select('cost_type, description, amount, currency, exchange_rate, quantity, unit, unit_price, source_id')
          .eq('budget_order_id', id)
          .is('deleted_at', null)
        if (ci?.length) {
          // cost_type → 预算 6 类别键
          const CT2CAT: Record<string, string> = {
            fabric: 'fabric', accessory: 'accessory', processing: 'processing', commission: 'processing',
            freight: 'forwarder', container: 'container', customs: 'container', logistics: 'logistics',
            procurement: 'fabric', other: 'logistics',
          }
          const map: Record<string, { name: string; qty: number; unit: string; unit_price: number; amount: number }[]> = {}
          for (const row of ci as Record<string, unknown>[]) {
            const key = CT2CAT[(row.cost_type as string) || ''] || 'logistics'
            // 数量/单位/单价：优先真实列，缺失时回退解析 source_id JSON（兼容历史数据）
            let qty = row.quantity != null ? Number(row.quantity) : null
            let unit = (row.unit as string) || ''
            let price = row.unit_price != null ? Number(row.unit_price) : null
            if (qty == null && typeof row.source_id === 'string') {
              try {
                const j = JSON.parse(row.source_id as string)
                if (j && typeof j === 'object') {
                  qty = j.qty ?? j.quantity ?? null
                  unit = unit || j.unit || ''
                  price = price ?? j.unit_price ?? j.price ?? null
                }
              } catch { /* source_id 非 JSON，忽略 */ }
            }
            const cur = (row.currency as string) || 'CNY'
            const rate = cur === 'CNY' ? 1 : (Number(row.exchange_rate) || 1)
            const amountCny = Math.round((Number(row.amount) || 0) * rate * 100) / 100
            ;(map[key] ||= []).push({ name: (row.description as string) || '', qty: qty ?? 0, unit, unit_price: price ?? 0, amount: amountCny })
          }
          setCostDetail(map)
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
        setOrderSettlementState(orderSettlement as OrderSettlement | null)
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
  const [gateResult, setGateResult] = useState<GateResult | null>(null)
  const [gateLoading, setGateLoading] = useState(false)
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
  // 各成本类别下的明细行（品名/数量/单位/单价/金额）；有明细时类别总额=明细之和
  type EditLine = { name: string; qty: string; unit: string; unitPrice: string; amount: string }
  const [editLines, setEditLines] = useState<Record<string, EditLine[]>>({})
  const [expandedCat, setExpandedCat] = useState<string | null>(null)
  const emptyLine = (): EditLine => ({ name: '', qty: '', unit: '', unitPrice: '', amount: '' })
  const lineSum = (ls: EditLine[] | undefined) =>
    (ls || []).reduce((s, l) => s + (Number(l.amount) || (Number(l.qty) || 0) * (Number(l.unitPrice) || 0)), 0)
  // 类别有效金额：有明细行用明细之和，否则用直接填的汇总值
  const catValue = (key: string, lumpStr: string) => {
    const ls = editLines[key]
    return ls && ls.length > 0 ? lineSum(ls) : (Number(lumpStr) || 0)
  }
  const addLine = (key: string) =>
    setEditLines(p => ({ ...p, [key]: [...(p[key] || []), emptyLine()] }))
  const removeLine = (key: string, idx: number) =>
    setEditLines(p => ({ ...p, [key]: (p[key] || []).filter((_, i) => i !== idx) }))
  const updateLine = (key: string, idx: number, field: keyof EditLine, value: string) =>
    setEditLines(p => {
      const list = [...(p[key] || [])]
      const line = { ...list[idx], [field]: value }
      // 数量×单价 自动算金额
      if (field === 'qty' || field === 'unitPrice') {
        const q = Number(field === 'qty' ? value : line.qty) || 0
        const up = Number(field === 'unitPrice' ? value : line.unitPrice) || 0
        if (q && up) line.amount = (q * up).toFixed(2)
      }
      list[idx] = line
      return { ...p, [key]: list }
    })

  // 进入编辑模式时预填当前值（从items或现有字段解析）
  useEffect(() => {
    if (editMode && order) {
      setEditRate((order.exchange_rate || 7).toString())
      setEditRevenue(order.total_revenue.toString())
      // 尝试从items中读取细分（之前保存的）
      const breakdown = (order.items as unknown as Record<string, unknown>[])?.[0]
      if (breakdown && breakdown._cost_breakdown) {
        const cb = breakdown._cost_breakdown as Record<string, number | string>
        // 恢复币种模式：写入方对 CNY 直收单写 _currency='CNY_DIRECT'（且总是带 _rate），
        // 兼容三种来源：新口径 CNY_DIRECT / _revenue_currency='CNY' / 旧数据 'CNY' 且无 _rate。
        // 此前判断写成 ('CNY' && !_rate) 永远为假 → CNY 单被还原成 USD 模式，
        // 再保存时人民币收入会被错乘汇率（利润虚增）。
        const isCnyDirect = cb._currency === 'CNY_DIRECT'
          || cb._revenue_currency === 'CNY'
          || (cb._currency === 'CNY' && !cb._rate)
        setEditCurrencyMode(isCnyDirect ? 'CNY' : 'USD')
        setEditFabric((cb.fabric || 0).toString())
        setEditAccessory((cb.accessory || 0).toString())
        setEditProcessing((cb.processing || 0).toString())
        setEditForwarder((cb.forwarder || 0).toString())
        setEditContainer((cb.container || 0).toString())
        setEditLogistics((cb.logistics || 0).toString())
        // 恢复其他费用
        const extras = cb.extras as unknown as { name: string; amount: number }[] | undefined
        setEditExtras(extras?.map(e => ({ name: e.name, amount: (e.amount || 0).toString() })) || [])
        // 恢复各类别明细行
        const savedLines = (cb as Record<string, unknown>).lines as Record<string, { name: string; qty: number; unit: string; unit_price: number; amount: number }[]> | undefined
        if (savedLines) {
          const restored: Record<string, EditLine[]> = {}
          for (const [k, arr] of Object.entries(savedLines)) {
            if (Array.isArray(arr) && arr.length > 0) {
              restored[k] = arr.map(l => ({
                name: l.name || '', qty: l.qty != null ? String(l.qty) : '',
                unit: l.unit || '', unitPrice: l.unit_price != null ? String(l.unit_price) : '',
                amount: l.amount != null ? String(l.amount) : '',
              }))
            }
          }
          setEditLines(restored)
        } else {
          setEditLines({})
        }
      } else {
        // 无 _cost_breakdown 的历史订单：按订单自身币种设置模式（否则默认 USD，
        // CNY 单保存时会被错乘汇率且 currency 被改写为 USD）
        setEditCurrencyMode(order.currency === 'CNY' ? 'CNY' : 'USD')
        setEditFabric(order.target_purchase_price.toString())
        setEditAccessory('0')
        setEditProcessing(order.estimated_commission.toString())
        setEditForwarder(order.estimated_freight.toString())
        setEditContainer(order.estimated_customs_fee.toString())
        setEditLogistics(order.other_costs.toString())
        setEditExtras([])
        setEditLines({})
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
    // 类别金额：有明细行时=明细之和，否则=直接填写的汇总值
    const fabric = catValue('fabric', editFabric)
    const accessory = catValue('accessory', editAccessory)
    const processing = catValue('processing', editProcessing)
    const forwarder = catValue('forwarder', editForwarder)
    const container = catValue('container', editContainer)
    const logistics = catValue('logistics', editLogistics)
    const extrasTotal = editExtras.reduce((s, e) => s + (Number(e.amount) || 0), 0)
    // 明细行 → 持久化形状（数字），丢弃空行
    const linesData: Record<string, { name: string; qty: number; unit: string; unit_price: number; amount: number }[]> = {}
    for (const [k, arr] of Object.entries(editLines)) {
      const cleaned = (arr || [])
        .map(l => {
          const qty = Number(l.qty) || 0
          const unitPrice = Number(l.unitPrice) || 0
          const amount = Number(l.amount) || qty * unitPrice
          return { name: l.name || '', qty, unit: l.unit || '', unit_price: unitPrice, amount }
        })
        // 只持久化「有实际金额」的明细行：丢弃仅有名称、金额为 0 的占位行，
        // 避免导出对账单/预算表时出现 ¥0 噪声行。
        .filter(l => l.amount > 0)
      if (cleaned.length > 0) linesData[k] = cleaned
    }
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
      const breakdownData = { fabric, accessory, processing, forwarder, container, logistics, extras: extrasData, lines: linesData, _currency: editCurrencyMode === 'CNY' ? 'CNY_DIRECT' : 'CNY', _revenue_input: revenueInput, _revenue_currency: editCurrencyMode, _rate: rate }
      // 保留原有产品明细，将cost breakdown存入第一个item或单独追加
      const existingItems = (order.items || []) as unknown as Record<string, unknown>[]
      const updatedItems = existingItems.length > 0
        ? [{ ...existingItems[0], _cost_breakdown: breakdownData }, ...existingItems.slice(1)]
        : [{ _cost_breakdown: breakdownData }]
      // .select() 取命中行：乐观锁 version 不匹配时 PostgREST 更新 0 行且不报错，
      // 必须显式判 0 行，否则并发冲突会被当成保存成功（本地展示一套 DB 里不存在的数字）
      const { data: hit, error } = await supabase.from('budget_orders').update({
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
      }).eq('id', order.id).eq('version', order.version || 1).select('id')

      if (error) {
        const msg = error.message
        if (msg.includes('已审批')) toast.error('已审批的订单不能修改金额，如需修改请先撤回审批')
        else if (msg.includes('非法状态转换')) toast.error(msg)
        else if (!error.details && error.code === 'PGRST116') toast.error('保存冲突：该记录已被其他用户修改，请刷新后重试')
        else toast.error('保存失败: ' + msg)
      } else if (!hit || hit.length === 0) {
        toast.error('保存冲突：该订单已被其他用户修改（版本不一致），请刷新页面后重新编辑')
      } else {
        // 写后验证
        const { data: verify } = await supabase.from('budget_orders').select('id, version, total_revenue, total_cost').eq('id', order.id).single()
        if (!verify) {
          console.error('[SaveGuard] budget_orders写后验证失败')
          toast.error('保存异常：请刷新页面确认')
        } else if (Math.abs((verify.total_cost as number) - totalCostCny) > 0.01) {
          console.error('[SaveGuard] budget_orders字段不一致: wrote cost=', totalCostCny, 'read=', verify.total_cost)
          toast.error('保存异常：金额不一致，请刷新页面')
        } else {
          toast.success('预算已保存')
        }
        setOrder({ ...order, total_revenue: revenueInput, currency: editCurrencyMode === 'CNY' ? 'CNY' : 'USD', exchange_rate: rate, target_purchase_price: purchase, estimated_freight: freight, estimated_commission: commission, estimated_customs_fee: customs, other_costs: other, total_cost: totalCostCny, estimated_profit: profitCny, estimated_margin: margin, version: (verify?.version as number) || (order.version || 1) + 1, items: updatedItems as unknown as typeof order.items })
        setEditMode(false)
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
    // 真实登录人——此前用 demoUser('user-fiona' 非UUID)导致审批必败、日志写不进(审计 P0/P1)
    const actorId = user?.id
    if (!actorId) { toast.error('登录态已失效，请重新登录后再审批'); return }
    // 自审批阻止：审批人不能是创建人
    if (action === 'approve' && actorId === order.created_by) {
      toast.error('不能审批自己创建的订单')
      return
    }
    // 汇率契约：外币订单审批前必须已补实际汇率（qimo 同步建单 exchange_rate 为空，
    // 若带空汇率进入 approved，营收折人民币/GL 入账会算成 0 或挂起）
    if (action === 'approve' && order.currency !== 'CNY' && !(Number(order.exchange_rate) > 0)) {
      toast.error('该订单为外币且未填写汇率，请先补填实际汇率再审批（否则营收折算与入账会出错）')
      return
    }

    // 1. 持久化状态变更到数据库
    const { error: statusError } = await updateBudgetOrderStatus(order.id, newStatus, actorId)
    if (statusError) {
      toast.error(`操作失败: ${statusError}`)
      return
    }

    // 2. 持久化审批记录（检查落库结果，失败明确提示——此前静默失败致审计链为空）
    const log: ApprovalLog = {
      id: `al-${Date.now()}`,
      entity_type: 'budget_order',
      entity_id: order.id,
      action,
      from_status: order.status,
      to_status: newStatus,
      operator_id: actorId,
      operator: user ?? undefined,
      comment: comment || null,
      created_at: new Date().toISOString(),
    }
    const { error: logError } = await createApprovalLog(log)
    if (logError) toast.warning(`状态已变更，但审批记录写入失败：${logError}`)

    // 3. 更新UI
    setOrder({ ...order, status: newStatus })
    setLogs([...logs, log])
    setComment('')
    setShowDialog(null)

    const actionLabels = { submit: '提交审批', approve: '审批通过', reject: '审批驳回' }
    toast.success(actionLabels[action], { description: `订单 ${order.order_no} 已${actionLabels[action]}` })
  }

  const handleGenerateSettlement = async () => {
    // 真实落库(此前只 toast+跳转,决算表不产生记录——假按钮，审计 P1)
    const { error } = await generateOrderSettlement(order.id)
    if (error) { toast.error(`生成决算单失败：${error}`); return }
    toast.success('决算单已生成', { description: `基于订单 ${order.order_no}` })
    router.push(`/orders/${order.id}/settlement`)
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
              <Button size="sm" disabled={gateLoading} onClick={async () => {
                setGateLoading(true)
                const result = await runOrderSubmitGate(order.id)
                setGateResult(result)
                setGateLoading(false)
              }}>
                {gateLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
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
            {order.status === 'rejected' && (
              <>
                <Button size="sm" variant="outline" onClick={() => handleStatusChange('submit', 'draft')}>
                  修改预算
                </Button>
                <Button size="sm" onClick={async () => {
                  if (!user?.id) { toast.error('登录态已失效，请重新登录'); return }
                  // rejected → draft → pending_review
                  const { error: e1 } = await updateBudgetOrderStatus(order.id, 'draft', user.id)
                  if (e1) { toast.error(`操作失败: ${e1}`); return }
                  const { error: e2 } = await updateBudgetOrderStatus(order.id, 'pending_review', user.id)
                  if (e2) { toast.error(`操作失败: ${e2}`); return }
                  setOrder({ ...order, status: 'pending_review' })
                  toast.success('已重新提交审批')
                }}>
                  <Send className="h-4 w-4 mr-1" />
                  重新提交审批
                </Button>
              </>
            )}
            {order.status === 'approved' && !settlement && (
              <Button size="sm" variant="outline" onClick={handleGenerateSettlement}>
                <FileText className="h-4 w-4 mr-1" />
                生成结算单
              </Button>
            )}
            {/* 导出预算表 */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                try {
                  const costItems = synthesizeCostItems(order)
                  exportBudgetOrSettlementToExcel(order, costItems, 'budget')
                  toast.success(`预算表 ${order.order_no} 已导出`)
                } catch (e) {
                  toast.error(`导出失败: ${e instanceof Error ? e.message : '未知错误'}`)
                }
              }}
            >
              <Download className="h-4 w-4 mr-1" />
              导出预算表
            </Button>
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
            {/* 预算表 —— 逐类目预算金额(总额口径)+ 实际归集对照。数据源:预算单 _cost_breakdown */}
            {(() => {
              const cbTop = (order.items as unknown as Record<string, unknown>[])?.[0]?._cost_breakdown as Record<string, number | string> | undefined
              if (!cbTop) return null
              const cats: { key: string; label: string }[] = [
                { key: 'fabric', label: '面料' },
                { key: 'accessory', label: '辅料' },
                { key: 'processing', label: '加工费' },
                { key: 'forwarder', label: '货代费' },
                { key: 'container', label: '装柜费' },
                { key: 'logistics', label: '物流费' },
              ]
              // 采购填价(采购在节拍器核料按真实物料填的单价×数量)——财务看 原辅料「预算(报价) vs 采购价」。
              // 2026-07-08 辅料先行,2026-07-09 扩到面料/加工。PO 应付尚未归集时先用采购填价当"采购价";已归集则用实际归集。
              const actualBuy: Record<string, number> = {
                fabric: Number(cbTop._actual_fabric) || 0,
                accessory: Number(cbTop._actual_accessory) || 0,
                processing: Number(cbTop._actual_processing) || 0,
              }
              const rows = cats.map(c => {
                const budget = Number(cbTop[c.key]) || 0
                let actual = (costDetail[c.key] || []).reduce((s, l) => s + (Number(l.amount) || 0), 0)
                let fromProc = false
                if (actual === 0 && (actualBuy[c.key] || 0) > 0) { actual = actualBuy[c.key]; fromProc = true }
                return { label: fromProc ? `${c.label}（采购填价）` : c.label, budget, actual, diff: actual - budget }
              })
              const extras = (cbTop.extras as unknown as { name: string; amount: number }[] | undefined) || []
              extras.forEach(e => rows.push({ label: e.name || '其他', budget: Number(e.amount) || 0, actual: 0, diff: -(Number(e.amount) || 0) }))
              const budgetTotal = order.total_cost || rows.reduce((s, r) => s + r.budget, 0)
              const actualTotal = rows.reduce((s, r) => s + r.actual, 0)
              const revenueCny = order.currency === 'CNY' ? order.total_revenue : order.total_revenue * (order.exchange_rate || 1)
              const hasActual = actualTotal > 0
              const fmt = (n: number) => `¥${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              return (
                <Card className="border-primary/20">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <CardTitle className="text-base font-semibold">预算表</CardTitle>
                      <div className="flex gap-4 text-xs">
                        <span className="text-muted-foreground">预算收入 <span className="font-semibold text-foreground">{fmt(revenueCny)}</span></span>
                        <span className="text-muted-foreground">预算利润 <span className={`font-semibold ${order.estimated_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>{fmt(order.estimated_profit)}</span></span>
                        <span className="text-muted-foreground">预算毛利率 <span className="font-semibold text-foreground">{order.estimated_margin}%</span></span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="text-sm">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground border-b">
                            <th className="text-left font-medium py-1.5">成本类目</th>
                            <th className="text-right font-medium py-1.5">预算(报价) CNY</th>
                            {hasActual && <th className="text-right font-medium py-1.5">采购价/实际</th>}
                            {hasActual && <th className="text-right font-medium py-1.5">差额</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={i} className="border-b border-muted/40">
                              <td className="py-1.5 text-muted-foreground">{r.label}</td>
                              <td className="py-1.5 text-right font-medium">{fmt(r.budget)}</td>
                              {hasActual && <td className="py-1.5 text-right text-amber-700">{r.actual ? fmt(r.actual) : '—'}</td>}
                              {hasActual && <td className={`py-1.5 text-right ${r.actual ? (r.diff > 0 ? 'text-red-600' : 'text-green-600') : 'text-muted-foreground/50'}`}>{r.actual ? `${r.diff > 0 ? '+' : ''}${fmt(r.diff)}` : '—'}</td>}
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="font-semibold border-t-2">
                            <td className="py-2">预算成本合计</td>
                            <td className="py-2 text-right">{fmt(budgetTotal)}</td>
                            {hasActual && <td className="py-2 text-right text-amber-700">{fmt(actualTotal)}</td>}
                            {hasActual && <td className={`py-2 text-right ${actualTotal - budgetTotal > 0 ? 'text-red-600' : 'text-green-600'}`}>{actualTotal - budgetTotal > 0 ? '+' : ''}{fmt(actualTotal - budgetTotal)}</td>}
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    {hasActual
                      ? <p className="text-[11px] text-muted-foreground mt-2">预算(报价)=业务报价/核料估算;采购价=采购核料填价或已归集采购(标「采购填价」者为采购核料填,未标为实际归集)。差额&gt;0=采购超预算(红),&lt;0=省(绿)。货代/装柜/物流为财务补充,无采购价对照。</p>
                      : <p className="text-[11px] text-muted-foreground mt-2">尚无采购价/实际归集,待采购核料填价或采购明细回传后自动显示「预算(报价) vs 采购价」对比。</p>}
                  </CardContent>
                </Card>
              )
            })()}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">基本信息</CardTitle>
                </CardHeader>
                <CardContent className="space-y-1.5 text-xs">
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
                    <CardTitle className="text-base font-semibold">成本构成</CardTitle>
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
                      const cats: { key: string; label: string; val: string; set: (v: string) => void }[] = [
                        { key: 'fabric', label: '面料', val: editFabric, set: setEditFabric },
                        { key: 'accessory', label: '辅料', val: editAccessory, set: setEditAccessory },
                        { key: 'processing', label: '加工费', val: editProcessing, set: setEditProcessing },
                        { key: 'forwarder', label: '货代费', val: editForwarder, set: setEditForwarder },
                        { key: 'container', label: '装柜费', val: editContainer, set: setEditContainer },
                        { key: 'logistics', label: '物流费', val: editLogistics, set: setEditLogistics },
                      ]
                      const costTotal = cats.reduce((s, c) => s + catValue(c.key, c.val), 0) + editExtras.reduce((s, e) => s + (Number(e.amount) || 0), 0)
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
                        <p className="text-[10px] text-muted-foreground font-medium">成本明细 (CNY 人民币) · 点 ▶ 展开可按行填 数量/单位/单价</p>
                        {cats.map(c => {
                          const lines = editLines[c.key] || []
                          const hasLines = lines.length > 0
                          const sum = lineSum(lines)
                          const expanded = expandedCat === c.key
                          return (
                            <div key={c.key} className="rounded-md border border-muted">
                              <div className="flex items-center gap-2 px-2 py-1.5">
                                <button type="button" className="text-muted-foreground hover:text-foreground text-xs w-4 shrink-0" onClick={() => setExpandedCat(expanded ? null : c.key)}>{expanded ? '▼' : '▶'}</button>
                                <Label className="text-xs flex-1 cursor-pointer" onClick={() => setExpandedCat(expanded ? null : c.key)}>{c.label} (¥){hasLines && <span className="text-[10px] text-primary ml-1">{lines.length}行明细</span>}</Label>
                                {hasLines ? (
                                  <span className="text-xs font-medium tabular-nums w-28 text-right pr-2" title="由明细自动合计">¥{sum.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                                ) : (
                                  <Input type="number" step="0.01" value={c.val} onChange={e => c.set(e.target.value)} className="h-7 w-28 text-right text-xs" />
                                )}
                              </div>
                              {expanded && (
                                <div className="px-2 pb-2 space-y-1.5 bg-muted/30">
                                  {hasLines && (
                                    <div className="grid grid-cols-[1fr_56px_44px_60px_68px_22px] gap-1 text-[10px] text-muted-foreground px-0.5 pt-1">
                                      <span>品名</span><span className="text-right">数量</span><span>单位</span><span className="text-right">单价</span><span className="text-right">金额</span><span />
                                    </div>
                                  )}
                                  {lines.map((l, idx) => (
                                    <div key={idx} className="grid grid-cols-[1fr_56px_44px_60px_68px_22px] gap-1 items-center">
                                      <Input placeholder="品名" value={l.name} onChange={e => updateLine(c.key, idx, 'name', e.target.value)} className="h-7 text-xs" />
                                      <Input type="number" placeholder="0" value={l.qty} onChange={e => updateLine(c.key, idx, 'qty', e.target.value)} className="h-7 text-xs text-right px-1" />
                                      <Input placeholder="kg" value={l.unit} onChange={e => updateLine(c.key, idx, 'unit', e.target.value)} className="h-7 text-xs px-1" />
                                      <Input type="number" step="0.01" placeholder="单价" value={l.unitPrice} onChange={e => updateLine(c.key, idx, 'unitPrice', e.target.value)} className="h-7 text-xs text-right px-1" />
                                      <Input type="number" step="0.01" placeholder="金额" value={l.amount} onChange={e => updateLine(c.key, idx, 'amount', e.target.value)} className="h-7 text-xs text-right px-1" />
                                      <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0 text-red-400 hover:text-red-600" onClick={() => removeLine(c.key, idx)}>×</Button>
                                    </div>
                                  ))}
                                  <Button type="button" size="sm" variant="ghost" className="h-6 text-[11px] text-primary px-1" onClick={() => addLine(c.key)}>+ 加明细行</Button>
                                </div>
                              )}
                            </div>
                          )
                        })}
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
                        {/* 防错提示 */}
                        {(() => {
                          const bw = validateBudgetEdit({
                            revenue: revenueInput, rate, currency: editCurrencyMode,
                            costs: { fabric: catValue('fabric', editFabric), accessory: catValue('accessory', editAccessory), processing: catValue('processing', editProcessing), forwarder: catValue('forwarder', editForwarder), container: catValue('container', editContainer), logistics: catValue('logistics', editLogistics) },
                          })
                          const errs = bw.filter(w => w.level === 'error')
                          const warns = bw.filter(w => w.level === 'warning')
                          if (errs.length === 0 && warns.length === 0) return null
                          return <div className="space-y-1">
                            {errs.map((w,i) => <div key={i} className="p-1.5 bg-red-50 border border-red-200 rounded text-[10px] text-red-700">❌ {w.message}</div>)}
                            {warns.map((w,i) => <div key={`w${i}`} className="p-1.5 bg-amber-50 border border-amber-200 rounded text-[10px] text-amber-700">⚠ {w.message}</div>)}
                          </div>
                        })()}
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
                      // 实际归集合计（费用归集已录入的实际成本，与预算成本分开显示）
                      const totalActualCost = Object.values(costDetail).flat().reduce((s, l) => s + (Number(l.amount) || 0), 0)
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
                        <p className="text-xs text-foreground font-semibold">成本明细 (CNY)</p>
                        {(() => {
                          const readLines = (cb as Record<string, unknown> | undefined)?.lines as Record<string, { name: string; qty: number; unit: string; unit_price: number; amount: number }[]> | undefined
                          const readCats: { key: string; label: string; fallback: number; bold?: boolean }[] = [
                            { key: 'fabric', label: '面料', fallback: Number(order.target_purchase_price) || 0, bold: true },
                            { key: 'accessory', label: '辅料', fallback: 0 },
                            { key: 'processing', label: '加工费', fallback: Number(order.estimated_commission) || 0 },
                            { key: 'forwarder', label: '货代费', fallback: Number(order.estimated_freight) || 0 },
                            { key: 'container', label: '装柜费', fallback: Number(order.estimated_customs_fee) || 0 },
                            { key: 'logistics', label: '物流费', fallback: Number(order.other_costs) || 0 },
                          ]
                          return readCats.map(rc => {
                            const lines = readLines?.[rc.key]
                            const hasPlanned = Array.isArray(lines) && lines.length > 0
                            // 预算未录明细时，回退展示费用归集（实际）的公斤数/单价，供核对
                            const actual = costDetail[rc.key]
                            const showActual = !hasPlanned && Array.isArray(actual) && actual.length > 0
                            const catAmt = cb?.[rc.key] != null ? Number(cb[rc.key]) : rc.fallback
                            // 实际归集行的合计（用于与预算分开显示，保证「明细加总=该数」）
                            const actualSum = showActual ? actual!.reduce((s, l) => s + (Number(l.amount) || 0), 0) : 0
                            return (
                              <div key={rc.key}>
                                <div className="flex justify-between items-baseline gap-2">
                                  <span className="text-muted-foreground">
                                    {rc.label}
                                    {hasPlanned && <span className="text-[11px] text-primary ml-1">{lines!.length}行</span>}
                                    {showActual && (
                                      <Link href={`/costs?q=${encodeURIComponent(syncedInfo?.internalNo || order.order_no)}`}
                                        className="text-[11px] text-amber-600 ml-1 underline decoration-dotted hover:text-amber-800"
                                        title="点击到费用归集查看这些行的录入人/时间，可编辑或删除">
                                        实际归集{actual!.length}行
                                      </Link>
                                    )}
                                  </span>
                                  {showActual ? (
                                    <span className="text-right whitespace-nowrap">
                                      <span className="text-[11px] text-muted-foreground/70">预算¥{catAmt.toLocaleString()} · 实际 </span>
                                      <span className="font-semibold text-amber-700">¥{actualSum.toLocaleString()}</span>
                                    </span>
                                  ) : (
                                    <span className={rc.bold ? 'font-medium' : ''}>¥ {catAmt.toLocaleString()}</span>
                                  )}
                                </div>
                                {hasPlanned && (
                                  <div className="pl-3 mt-0.5 mb-1 space-y-0.5">
                                    {lines!.map((l, i) => (
                                      <div key={i} className="flex justify-between text-xs text-muted-foreground">
                                        <span className="truncate max-w-[150px]">· {l.name || '明细'}{(Number(l.qty) || Number(l.unit_price)) ? ` ${l.qty || 0}${l.unit || ''}×¥${l.unit_price || 0}` : ''}</span>
                                        <span>¥ {(Number(l.amount) || 0).toLocaleString()}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {showActual && (
                                  <div className="pl-3 mt-0.5 mb-1 space-y-0.5 border-l-2 border-amber-200">
                                    {actual!.map((l, i) => (
                                      <div key={i} className="flex justify-between text-xs text-amber-700">
                                        <span className="truncate max-w-[160px]">· {l.name || '明细'}{(Number(l.qty) || Number(l.unit_price)) ? ` ${l.qty || 0}${l.unit || ''}×¥${l.unit_price || 0}` : ''}</span>
                                        <span>¥ {(Number(l.amount) || 0).toLocaleString()}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )
                          })
                        })()}
                        {(cb?.extras as unknown as { name: string; amount: number }[] | undefined)?.map((e, i) => (
                          <div key={i} className="flex justify-between"><span className="text-muted-foreground">{e.name}</span><span>¥ {e.amount.toLocaleString()}</span></div>
                        ))}
                        <Separator />
                        <div className="flex justify-between font-semibold text-sm"><span>预算成本合计</span><span>¥ {order.total_cost.toLocaleString()}</span></div>
                        {totalActualCost > 0 && (
                          <div className="flex justify-between text-amber-700 text-sm"><span>实际归集合计</span><span className="font-semibold">¥ {totalActualCost.toLocaleString()}</span></div>
                        )}
                      </>
                    })()
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
                  <CardTitle className="text-sm">利润概览</CardTitle>
                  {orderSettlement && (orderSettlement.status === 'confirmed' || orderSettlement.status === 'locked') && (
                    <Badge className="bg-green-100 text-green-700 border-green-200 text-[10px]">
                      ✓ 决算已确认
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* 主要数字：决算已确认时显示实际利润，否则显示预计利润 */}
                  {orderSettlement && (orderSettlement.status === 'confirmed' || orderSettlement.status === 'locked') ? (
                    <div className="text-center p-4 rounded-lg bg-green-50/60 border border-green-200">
                      <p className="text-sm text-muted-foreground mb-1">实际利润 (CNY) · 来自决算</p>
                      <p className={`text-3xl font-bold ${orderSettlement.final_profit < 0 ? 'text-red-600' : 'text-green-700'}`}>
                        ¥ {orderSettlement.final_profit.toLocaleString()}
                      </p>
                      {/* 与预算对比 */}
                      {(() => {
                        const diff = orderSettlement.final_profit - order.estimated_profit
                        const diffPct = order.estimated_profit !== 0
                          ? (diff / Math.abs(order.estimated_profit)) * 100
                          : 0
                        if (Math.abs(diff) < 1) return <p className="text-xs text-muted-foreground mt-1">与预算一致</p>
                        return (
                          <p className={`text-xs mt-1 ${diff > 0 ? 'text-green-700' : 'text-red-700'}`}>
                            vs 预算 ¥{order.estimated_profit.toLocaleString()} · {diff > 0 ? '+' : ''}¥{diff.toLocaleString()} ({diff > 0 ? '+' : ''}{diffPct.toFixed(1)}%)
                          </p>
                        )
                      })()}
                    </div>
                  ) : (
                    <div className="text-center p-4 rounded-lg bg-muted">
                      <p className="text-sm text-muted-foreground mb-1">预计利润 (CNY)</p>
                      <p className={`text-3xl font-bold ${order.estimated_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                        ¥ {order.estimated_profit.toLocaleString()}
                      </p>
                    </div>
                  )}

                  {/* 合同金额 + 毛利率 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="text-center p-3 rounded-lg bg-blue-50">
                      <p className="text-xs text-muted-foreground">合同金额</p>
                      <p className="text-sm font-semibold text-blue-700">{order.currency === 'CNY' ? '¥' : '$'} {order.total_revenue.toLocaleString()}</p>
                    </div>
                    {orderSettlement && (orderSettlement.status === 'confirmed' || orderSettlement.status === 'locked') ? (
                      <div className="text-center p-3 rounded-lg bg-green-50/60 border border-green-100">
                        <p className="text-xs text-muted-foreground">实际毛利率</p>
                        <p className={`text-sm font-semibold ${orderSettlement.final_margin < 0 ? 'text-red-700' : orderSettlement.final_margin < 15 ? 'text-amber-700' : 'text-green-700'}`}>
                          {orderSettlement.final_margin}%
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">预算 {order.estimated_margin}%</p>
                      </div>
                    ) : (
                      <div className="text-center p-3 rounded-lg bg-amber-50">
                        <p className="text-xs text-muted-foreground">预计毛利率</p>
                        <p className={`text-sm font-semibold ${order.estimated_margin < 0 ? 'text-red-700' : order.estimated_margin < 15 ? 'text-amber-700' : 'text-green-700'}`}>
                          {order.estimated_margin}%
                        </p>
                      </div>
                    )}
                  </div>

                  {/* 警告（基于显示中的有效毛利率） */}
                  {(() => {
                    const effectiveMargin = orderSettlement && (orderSettlement.status === 'confirmed' || orderSettlement.status === 'locked')
                      ? orderSettlement.final_margin
                      : order.estimated_margin
                    if (effectiveMargin < 0) {
                      return (
                        <div className="flex items-center gap-2 p-2 rounded-lg bg-red-50 text-red-700 text-xs" role="alert">
                          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{orderSettlement && orderSettlement.status !== 'draft' ? '实际亏损' : '预计亏损，请谨慎评估'}</span>
                        </div>
                      )
                    }
                    if (effectiveMargin < 15) {
                      return (
                        <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-50 text-amber-700 text-xs" role="alert">
                          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>毛利率低于15%警戒线</span>
                        </div>
                      )
                    }
                    return null
                  })()}

                  {/* 提示：决算未生成时引导 */}
                  {!orderSettlement && (order.status === 'approved' || order.status === 'closed') && (
                    <Link href={`/orders/${order.id}/settlement`} className="block">
                      <div className="flex items-center justify-center gap-1.5 p-2 rounded-lg bg-blue-50 text-blue-700 text-xs hover:bg-blue-100 transition-colors">
                        <Calculator className="h-3.5 w-3.5" />
                        <span>订单已批准，可去决算页生成决算单查看实际毛利</span>
                      </div>
                    </Link>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* 快捷操作入口（approved + closed 都展示，方便已完结订单回看） */}
            {(order.status === 'approved' || order.status === 'closed') && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <Link href={`/orders/${order.id}/shipping`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer border-blue-200 hover:border-blue-400 h-full">
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-blue-50"><Ship className="h-5 w-5 text-blue-600" /></div>
                      <div><p className="text-sm font-medium">出货管理</p><p className="text-xs text-muted-foreground">PI/CI/装箱单/报关</p></div>
                    </CardContent>
                  </Card>
                </Link>
                <Link href={`/orders/${order.id}/settlement`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer border-green-200 hover:border-green-400 h-full">
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-green-50"><Calculator className="h-5 w-5 text-green-600" /></div>
                      <div><p className="text-sm font-medium">订单决算</p><p className="text-xs text-muted-foreground">实际成本 vs 预算</p></div>
                    </CardContent>
                  </Card>
                </Link>
                <Link href={`/profit-control/${order.id}`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer border-purple-200 hover:border-purple-400 h-full">
                    <CardContent className="p-4 flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-purple-50"><LineChart className="h-5 w-5 text-purple-600" /></div>
                      <div><p className="text-sm font-medium">利润详情</p><p className="text-xs text-muted-foreground">按款式拆解 · 优化建议</p></div>
                    </CardContent>
                  </Card>
                </Link>
                <Link href="/payments">
                  <Card className="hover:shadow-md transition-shadow cursor-pointer border-amber-200 hover:border-amber-400 h-full">
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

      {/* 提交前核查报告 */}
      {gateResult && (
        <Dialog open onOpenChange={() => setGateResult(null)}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{gateResult.canSubmit ? '✅ 核查通过' : '❌ 核查未通过'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <p className="text-sm text-muted-foreground">{gateResult.summary}</p>
              {gateResult.errors.map((c, i) => (
                <div key={`e${i}`} className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <span className="text-red-600 font-bold shrink-0">✗</span>
                  <div>
                    <p className="text-sm font-medium text-red-800">{c.name}：{c.message}</p>
                    {c.suggestion && <p className="text-xs text-red-600 mt-0.5">→ {c.suggestion}</p>}
                  </div>
                </div>
              ))}
              {gateResult.warnings.map((c, i) => (
                <div key={`w${i}`} className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <span className="text-amber-600 font-bold shrink-0">⚠</span>
                  <div>
                    <p className="text-sm font-medium text-amber-800">{c.name}：{c.message}</p>
                    {c.suggestion && <p className="text-xs text-amber-600 mt-0.5">→ {c.suggestion}</p>}
                  </div>
                </div>
              ))}
              {gateResult.passed.map((c, i) => (
                <div key={`p${i}`} className="flex items-center gap-2 p-2 bg-green-50 border border-green-200 rounded-lg">
                  <span className="text-green-600 shrink-0">✓</span>
                  <p className="text-sm text-green-800">{c.name}：{c.message}</p>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setGateResult(null)}>返回修改</Button>
              {gateResult.canSubmit && (
                <Button onClick={() => {
                  setGateResult(null)
                  handleStatusChange('submit', 'pending_review')
                }}>
                  <Send className="h-4 w-4 mr-1" />确认提交
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

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
