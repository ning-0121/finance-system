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
import { ArrowLeft, Plus, Loader2, Package, TrendingUp, TrendingDown, CheckCircle, Warehouse } from 'lucide-react'
import { toast } from 'sonner'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { getBudgetOrderById, getSettlementByBudgetId } from '@/lib/supabase/queries'
import { generateOrderSettlement, getOrderSettlement, getSubDocuments, getInventoryReturns } from '@/lib/supabase/queries-v2'
import { toChineseUppercase } from '@/lib/excel/chinese-amount'
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
  const [showAddReturn, setShowAddReturn] = useState(false)

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
    } catch {
      setReturns([...returns, {
        id: `ir-${Date.now()}`, budget_order_id: id, sub_document_id: null,
        return_type: returnType as InventoryReturn['return_type'],
        items: [{ name: returnDesc, specification: null, qty: 1, unit: 'LOT', unit_price: Number(returnValue), amount: Number(returnValue) }],
        total_value: Number(returnValue), warehouse_location: null,
        accounting_treatment: returnTreatment as InventoryReturn['accounting_treatment'],
        processed_by: null, processed_at: null, created_at: new Date().toISOString(),
      }])
    }
    toast.success('入库记录已添加')
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
          <div className="flex gap-2">
            <Link href={`/orders/${id}/shipping`}><Button variant="outline" size="sm">出货单据</Button></Link>
            <Button size="sm" onClick={handleGenerateSettlement} disabled={generating}>
              {generating ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
              {settlement ? '重新生成决算' : '生成决算单'}
            </Button>
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
                          <TableCell className="text-right font-medium">${r.total_value.toLocaleString()}</TableCell>
                          <TableCell><Badge variant={r.accounting_treatment === 'reduce_cost' ? 'default' : r.accounting_treatment === 'scrap' ? 'destructive' : 'secondary'}>{treatmentLabels[r.accounting_treatment]}</Badge></TableCell>
                        </TableRow>
                      ))}
                      {totalReturnCredit > 0 && (
                        <TableRow className="bg-green-50/50 font-semibold">
                          <TableCell colSpan={2} className="text-right">冲减成本合计</TableCell>
                          <TableCell className="text-right text-green-600">-${totalReturnCredit.toLocaleString()}</TableCell>
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
                  <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">预算总成本</p><p className="text-xl font-bold">${settlement.total_budget.toLocaleString()}</p></CardContent></Card>
                  <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">实际总成本</p><p className="text-xl font-bold">${settlement.total_actual.toLocaleString()}</p></CardContent></Card>
                  <Card className={settlement.total_variance > 0 ? 'border-red-200' : 'border-green-200'}>
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-muted-foreground">总差异</p>
                      <p className={`text-xl font-bold flex items-center justify-center gap-1 ${settlement.total_variance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {settlement.total_variance > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                        ${Math.abs(settlement.total_variance).toLocaleString()}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className={settlement.final_profit < 0 ? 'border-red-200 bg-red-50/30' : 'border-green-200 bg-green-50/30'}>
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-muted-foreground">最终利润</p>
                      <p className={`text-xl font-bold ${settlement.final_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                        ${settlement.final_profit.toLocaleString()} ({settlement.final_margin}%)
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
                              <TableCell className="text-right">${s.budgeted.toLocaleString()}</TableCell>
                              <TableCell className="text-right">${s.actual.toLocaleString()}</TableCell>
                              <TableCell className={`text-right font-semibold ${s.variance > 0 ? 'text-red-600' : s.variance < 0 ? 'text-green-600' : ''}`}>
                                {s.variance > 0 ? '+' : ''}${s.variance.toLocaleString()}
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
                      <p className="text-lg font-bold text-green-600">-${settlement.inventory_credit.toLocaleString()}</p>
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
