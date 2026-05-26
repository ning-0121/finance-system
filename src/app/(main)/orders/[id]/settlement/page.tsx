'use client'

import { use, useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ArrowLeft, Plus, Loader2, Package, TrendingUp, TrendingDown, CheckCircle, Warehouse, Download } from 'lucide-react'
import { toast } from 'sonner'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { getBudgetOrderById, getSettlementByBudgetId } from '@/lib/supabase/queries'
import { generateOrderSettlement, getOrderSettlement, getSubDocuments, getInventoryReturns } from '@/lib/supabase/queries-v2'
import { toChineseUppercase } from '@/lib/excel/chinese-amount'
import { exportSettlementSheetToExcel } from '@/lib/excel/export-settlement-sheet'
import { exportBudgetOrSettlementToExcel, synthesizeCostItems, type CostItemRow } from '@/lib/excel/export-budget-sheet'
import {
  buildSettlementBundle,
  exportSettlementInvoiceToExcel,
  synthesizeExpensesFromBudget,
} from '@/lib/excel/export-settlement-invoice'
import type { SubDocument, InventoryReturn, OrderSettlement } from '@/lib/types'

const returnTypeLabels: Record<string, string> = {
  raw_material: '原料', auxiliary: '辅料', finished_good: '成品', defective: '次品',
}
const treatmentLabels: Record<string, string> = {
  add_to_cost: '计入成本', reduce_cost: '冲减成本', scrap: '报废',
}

export default function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [loading, setLoading] = useState(true)
  const [order, setOrder] = useState<Awaited<ReturnType<typeof getBudgetOrderById>>>(null)
  const [subDocs, setSubDocs] = useState<SubDocument[]>([])
  const [returns, setReturns] = useState<InventoryReturn[]>([])
  const [settlement, setSettlement] = useState<OrderSettlement | null>(null)
  const [generating, setGenerating] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [showAddReturn, setShowAddReturn] = useState(false)
  const [costItemRows, setCostItemRows] = useState<CostItemRow[]>([])
  const [costSource, setCostSource] = useState<'actual' | 'estimated'>('actual')
  // Wave 4 · 核算单(图片格式) 数据源
  const [invoiceReceipts, setInvoiceReceipts] = useState<Array<{ invoice_date: string|null; total_amount: number; currency: string; exchange_rate: number|null; supplier_name: string|null; invoice_no: string|null }>>([])
  const [invoiceExpenses, setInvoiceExpenses] = useState<Array<{ cost_type: string; description: string|null; supplier: string|null; cost_group: string|null; quantity: number|null; unit: string|null; unit_price: number|null; amount: number; currency: string; exchange_rate: number|null; created_at: string }>>([])
  const [shipCompletedAt, setShipCompletedAt] = useState<string | null>(null)

  // 入库表单
  const [returnType, setReturnType] = useState('raw_material')
  const [returnValue, setReturnValue] = useState('')
  const [returnTreatment, setReturnTreatment] = useState('reduce_cost')
  const [returnDesc, setReturnDesc] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [orderData, subDocsData, returnsData, settlementData] = await Promise.all([
        getBudgetOrderById(id),
        getSubDocuments(id),
        getInventoryReturns(id),
        getOrderSettlement(id),
      ])
      setOrder(orderData)
      setSubDocs(subDocsData)
      setReturns(returnsData)
      setSettlement(settlementData)

      // 加载实际成本明细（用于新格式决算单导出）
      // 优先从 cost_items 表读取实际成本；无数据则降级合成，并标记来源
      try {
        const { data: dbCostItems } = await createClient()
          .from('cost_items')
          .select('description, supplier, amount, detail_meta, created_at')
          .eq('budget_order_id', id)
          .order('created_at')
        if (dbCostItems && dbCostItems.length > 0) {
          setCostSource('actual')
          setCostItemRows(dbCostItems.map((c) => {
            const meta = c.detail_meta as Record<string, unknown> | null
            return {
              date: c.created_at ? String(c.created_at).substring(5, 10) : undefined,
              description: String(c.description || ''),
              supplier: c.supplier ? String(c.supplier) : undefined,
              unit: meta?.unit ? String(meta.unit) : undefined,
              qty: meta?.qty != null ? Number(meta.qty) : null,
              unitPrice: meta?.unit_price != null ? Number(meta.unit_price) : null,
              amount: Number(c.amount || 0),
            }
          }))
        } else if (orderData) {
          // 无 cost_items 记录 → 降级使用预算成本估算，Excel 中标注
          setCostSource('estimated')
          setCostItemRows(synthesizeCostItems(orderData))
        }
      } catch {
        if (orderData) {
          setCostSource('estimated')
          setCostItemRows(synthesizeCostItems(orderData))
        }
      }

      // Wave 4 核算单数据：回款 + 完整成本 + 完结日期
      try {
        const sb = createClient()
        const [{ data: receipts }, { data: costs }, { data: ship }] = await Promise.all([
          sb.from('actual_invoices')
            .select('invoice_date, total_amount, currency, exchange_rate, supplier_name, invoice_no')
            .eq('budget_order_id', id)
            .eq('invoice_type', 'customer_statement')
            .eq('status', 'paid')
            .is('deleted_at', null)
            .order('invoice_date', { ascending: true }),
          sb.from('cost_items')
            .select('cost_type, description, supplier, cost_group, quantity, unit, unit_price, amount, currency, exchange_rate, created_at')
            .eq('budget_order_id', id)
            .is('deleted_at', null)
            .order('cost_group, supplier, created_at'),
          sb.from('shipping_documents')
            .select('completed_at, updated_at, status')
            .eq('budget_order_id', id)
            .eq('status', 'completed')
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ])
        setInvoiceReceipts(receipts || [])
        setInvoiceExpenses(costs || [])
        setShipCompletedAt((ship?.completed_at as string | undefined) || (ship?.updated_at as string | undefined) || null)
      } catch (err) {
        console.error('[settlement] 核算单数据加载失败:', err)
      }

      setLoading(false)
    }
    load()
  }, [id])

  const handleGenerateSettlement = async () => {
    setGenerating(true)
    const { error } = await generateOrderSettlement(id)
    if (error) {
      toast.error(`决算生成失败: ${error}`)
    } else {
      const data = await getOrderSettlement(id)
      setSettlement(data)
      toast.success('订单决算单已生成')
    }
    setGenerating(false)
  }

  const handleConfirmSettlement = async () => {
    if (!settlement) return
    setConfirming(true)
    try {
      const res = await fetch(`/api/orders/${id}/settlement`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      const data = await getOrderSettlement(id)
      setSettlement(data)
      toast.success(d.message || '决算已确认，应付记录已生成')
    } catch (e) {
      toast.error(`确认失败: ${e instanceof Error ? e.message : '未知'}`)
    }
    setConfirming(false)
  }

  const handleAddReturn = async () => {
    if (!returnDesc || !returnValue) { toast.error('请填写完整信息'); return }
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('inventory_returns')
        .insert({
          budget_order_id: id,
          return_type: returnType,
          items: [{ name: returnDesc, specification: null, qty: 1, unit: 'LOT', unit_price: Number(returnValue), amount: Number(returnValue) }],
          total_value: Number(returnValue),
          accounting_treatment: returnTreatment,
        })
        .select()
        .single()

      if (error) throw error
      setReturns([...returns, data as InventoryReturn])
      toast.success('入库记录已添加')
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
    setShowAddReturn(false)
    setReturnDesc('')
    setReturnValue('')
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const totalReturnCredit = returns.filter(r => r.accounting_treatment === 'reduce_cost').reduce((s, r) => s + r.total_value, 0)

  return (
    <div className="flex flex-col h-full">
      <Header title="订单决算" subtitle={`${order?.order_no || id} · 子单据决算 → 汇总`} />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <Link href={`/orders/${id}`}><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />返回订单</Button></Link>
          <div className="flex gap-2 flex-wrap">
            <Link href={`/orders/${id}/shipping`}><Button variant="outline" size="sm">出货单据</Button></Link>
            <Button size="sm" onClick={handleGenerateSettlement} disabled={generating || settlement?.status === 'confirmed' || settlement?.status === 'locked'}>
              {generating ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
              {settlement ? '重新生成决算' : '生成决算单'}
            </Button>
            {settlement && (settlement.status === 'draft' || !settlement.status) && (
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={handleConfirmSettlement}
                disabled={confirming}
              >
                {confirming ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                确认决算
              </Button>
            )}
            {settlement && (settlement.status === 'confirmed' || settlement.status === 'locked') && (
              <Badge className="bg-green-100 text-green-700 border-green-200">✅ 已确认</Badge>
            )}
            {/* F4: 导出决算单（任何已生成的决算都可以导出，draft 也行） */}
            {settlement && order && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  try {
                    exportSettlementSheetToExcel(order, settlement, returns)
                    toast.success(`决算单 ${order.order_no} 已导出`)
                  } catch (e) {
                    toast.error(`导出失败: ${e instanceof Error ? e.message : '未知错误'}`)
                  }
                }}
              >
                <Download className="h-4 w-4 mr-1" />
                导出决算单
              </Button>
            )}
            {/* 新格式决算单导出（义乌绮陌标准格式，支持降级标注） */}
            {order && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  try {
                    exportBudgetOrSettlementToExcel(order, costItemRows, 'settlement', costSource)
                    toast.success(`决算单(标准格式) ${order.order_no} 已导出${costSource === 'estimated' ? ' ⚠ 使用预算估算成本' : ''}`)
                  } catch (e) {
                    toast.error(`导出失败: ${e instanceof Error ? e.message : '未知错误'}`)
                  }
                }}
              >
                <Download className="h-4 w-4 mr-1" />
                导出决算单(标准格式)
              </Button>
            )}
            {/* Wave 4 · 订单核算单（图片复刻：6行头 + 收/支 + 毛利） */}
            {order && (
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  try {
                    const orderWithCustomer = {
                      ...order,
                      product_name: (order as { product_name?: string }).product_name || null,
                      customer_name: (order as { customers?: { company?: string } }).customers?.company || '',
                    }
                    const bundle = buildSettlementBundle(
                      orderWithCustomer as never,
                      invoiceReceipts,
                      invoiceExpenses.length > 0 ? invoiceExpenses : synthesizeExpensesFromBudget(order),
                      shipCompletedAt,
                    )
                    exportSettlementInvoiceToExcel(bundle)
                    const warn = [
                      bundle.meta.cost_source === 'estimated' && '⚠ 使用预算估算成本',
                      bundle.meta.receipt_source === 'pending' && '⚠ 尚无实际回款',
                    ].filter(Boolean).join(' ')
                    toast.success(`核算单 ${order.order_no} 已导出${warn ? ' (' + warn + ')' : ''}`)
                  } catch (e) {
                    toast.error(`导出失败: ${e instanceof Error ? e.message : '未知错误'}`)
                  }
                }}
              >
                <Download className="h-4 w-4 mr-1" />
                导出核算单(图片格式)
              </Button>
            )}
          </div>
        </div>

        <Tabs defaultValue="inventory">
          <TabsList>
            <TabsTrigger value="inventory">剩余物料入库 ({returns.length})</TabsTrigger>
            <TabsTrigger value="settlement">订单决算单 {settlement && <Badge variant="secondary" className="ml-1 text-[10px]">已生成</Badge>}</TabsTrigger>
          </TabsList>

          {/* 入库Tab */}
          <TabsContent value="inventory" className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">订单结束后的剩余原辅料、成品、次品入库处理</p>
              <Button size="sm" variant="outline" onClick={() => setShowAddReturn(true)}>
                <Plus className="h-4 w-4 mr-1" />添加入库
              </Button>
            </div>

            {returns.length === 0 ? (
              <Card><CardContent className="py-12 text-center text-muted-foreground"><Warehouse className="h-10 w-10 mx-auto mb-2 opacity-30" /><p>暂无入库记录</p></CardContent></Card>
            ) : (
              <Card>
                <CardContent className="p-0 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>类型</TableHead>
                        <TableHead>描述</TableHead>
                        <TableHead className="text-right">金额</TableHead>
                        <TableHead>会计处理</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {returns.map(r => (
                        <TableRow key={r.id}>
                          <TableCell><Badge variant="outline">{returnTypeLabels[r.return_type]}</Badge></TableCell>
                          <TableCell>{r.items?.[0]?.name || '-'}</TableCell>
                          <TableCell className="text-right font-medium">¥{r.total_value.toLocaleString()}</TableCell>
                          <TableCell><Badge variant={r.accounting_treatment === 'reduce_cost' ? 'default' : r.accounting_treatment === 'scrap' ? 'destructive' : 'secondary'}>{treatmentLabels[r.accounting_treatment]}</Badge></TableCell>
                        </TableRow>
                      ))}
                      {totalReturnCredit > 0 && (
                        <TableRow className="bg-green-50/50 font-semibold">
                          <TableCell colSpan={2} className="text-right">冲减成本合计</TableCell>
                          <TableCell className="text-right text-green-600">-¥{totalReturnCredit.toLocaleString()}</TableCell>
                          <TableCell />
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* 决算Tab */}
          <TabsContent value="settlement" className="mt-4 space-y-4">
            {!settlement ? (
              <Card><CardContent className="py-12 text-center text-muted-foreground"><p>点击"生成决算单"按钮计算最终利润</p></CardContent></Card>
            ) : (
              <>
                {/* 决算汇总 */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">预算总成本</p><p className="text-xl font-bold">¥{settlement.total_budget.toLocaleString()}</p></CardContent></Card>
                  <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">实际总成本</p><p className="text-xl font-bold">¥{settlement.total_actual.toLocaleString()}</p></CardContent></Card>
                  <Card className={settlement.total_variance > 0 ? 'border-red-200' : 'border-green-200'}>
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-muted-foreground">总差异</p>
                      <p className={`text-xl font-bold flex items-center justify-center gap-1 ${settlement.total_variance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {settlement.total_variance > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                        ¥{Math.abs(settlement.total_variance).toLocaleString()}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className={settlement.final_profit < 0 ? 'border-red-200 bg-red-50/30' : 'border-green-200 bg-green-50/30'}>
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-muted-foreground">最终利润</p>
                      <p className={`text-xl font-bold ${settlement.final_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                        ¥{settlement.final_profit.toLocaleString()} ({settlement.final_margin}%)
                      </p>
                    </CardContent>
                  </Card>
                </div>

                {/* 大写金额 */}
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-muted-foreground">最终利润大写</p>
                    <p className="text-lg font-semibold mt-1">{toChineseUppercase(Math.abs(settlement.final_profit))}{settlement.final_profit < 0 ? '（亏损）' : ''}</p>
                  </CardContent>
                </Card>

                {/* 子单据决算明细 */}
                {settlement.sub_settlements?.length > 0 && (
                  <Card>
                    <CardHeader className="pb-3"><CardTitle className="text-sm">子单据决算明细</CardTitle></CardHeader>
                    <CardContent className="p-0 overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>类型</TableHead>
                            <TableHead>供应商</TableHead>
                            <TableHead className="text-right">预算</TableHead>
                            <TableHead className="text-right">实际</TableHead>
                            <TableHead className="text-right">差异</TableHead>
                            <TableHead className="text-right">差异率</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {settlement.sub_settlements.map((s, i) => (
                            <TableRow key={i}>
                              <TableCell>{s.doc_type}</TableCell>
                              <TableCell>{s.supplier_name || '-'}</TableCell>
                              <TableCell className="text-right">¥{s.budgeted.toLocaleString()}</TableCell>
                              <TableCell className="text-right">¥{s.actual.toLocaleString()}</TableCell>
                              <TableCell className={`text-right font-semibold ${s.variance > 0 ? 'text-red-600' : s.variance < 0 ? 'text-green-600' : ''}`}>
                                {s.variance > 0 ? '+' : ''}¥{s.variance.toLocaleString()}
                              </TableCell>
                              <TableCell className={`text-right ${s.variance_pct > 0 ? 'text-red-600' : s.variance_pct < 0 ? 'text-green-600' : ''}`}>
                                {s.variance_pct > 0 ? '+' : ''}{s.variance_pct}%
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </CardContent>
                  </Card>
                )}

                {/* 库存冲减 */}
                {settlement.inventory_credit > 0 && (
                  <Card className="border-green-200">
                    <CardContent className="p-4 flex items-center justify-between">
                      <div><p className="text-sm font-medium">剩余物料冲减</p><p className="text-xs text-muted-foreground">冲减后已从实际成本中扣除</p></div>
                      <p className="text-lg font-bold text-green-600">-¥{settlement.inventory_credit.toLocaleString()}</p>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* 添加入库弹窗 */}
      <Dialog open={showAddReturn} onOpenChange={setShowAddReturn}>
        <DialogContent>
          <DialogHeader><DialogTitle>添加入库记录</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>类型</Label>
                <Select value={returnType} onValueChange={v => setReturnType(v || 'raw_material')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(returnTypeLabels).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>会计处理</Label>
                <Select value={returnTreatment} onValueChange={v => setReturnTreatment(v || 'reduce_cost')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(treatmentLabels).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2"><Label>描述 *</Label><Input placeholder="例: LED灯带剩余200卷" value={returnDesc} onChange={e => setReturnDesc(e.target.value)} /></div>
            <div className="space-y-2"><Label>金额 *</Label><Input type="number" placeholder="0.00" value={returnValue} onChange={e => setReturnValue(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddReturn(false)}>取消</Button>
            <Button onClick={handleAddReturn}>确认入库</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
