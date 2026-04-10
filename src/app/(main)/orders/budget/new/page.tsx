'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createBudgetOrder, getCustomers, getProducts } from '@/lib/supabase/queries'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { demoCustomers as fallbackCustomers, demoProducts as fallbackProducts } from '@/lib/demo-data'
import { ArrowLeft, Plus, Trash2, Sparkles, Save, Send, Loader2 } from 'lucide-react'
import Link from 'next/link'
import type { OrderItem, SubDocumentType, SubDocItem } from '@/lib/types'
import { SUB_DOC_LABELS } from '@/lib/types'

// 子单据表单状态
interface SubDocForm {
  id: string
  doc_type: SubDocumentType
  supplier_name: string
  items: SubDocItem[]
  estimated_total: number
  notes: string
}

const emptySubDocItem = (): SubDocItem => ({ name: '', specification: null, qty: 0, unit: 'PCS', unit_price: 0, amount: 0 })
const newSubDoc = (type: SubDocumentType): SubDocForm => ({
  id: `sd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  doc_type: type,
  supplier_name: '',
  items: [emptySubDocItem()],
  estimated_total: 0,
  notes: '',
})

export default function NewBudgetOrderPage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [customers, setCustomers] = useState(fallbackCustomers)
  const [products, setProducts] = useState(fallbackProducts)

  // 基本信息
  const [customerId, setCustomerId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [exchangeRate, setExchangeRate] = useState('7.24')
  const [orderDate, setOrderDate] = useState(new Date().toISOString().split('T')[0])
  const [deliveryDate, setDeliveryDate] = useState('')
  const [quoteNo, setQuoteNo] = useState('')
  const [poNo, setPoNo] = useState('')
  const [notes, setNotes] = useState('')

  // 产品明细（客户卖出的产品）
  const [items, setItems] = useState<OrderItem[]>([
    { product_id: '', product_name: '', sku: '', qty: 0, unit: 'PCS', unit_price: 0, amount: 0 },
  ])

  // 预算子单据
  const [subDocs, setSubDocs] = useState<SubDocForm[]>([
    newSubDoc('raw_material'),
    newSubDoc('factory_processing'),
  ])

  // 订单级费用（运费/佣金/报关费等）
  const [estimatedFreight, setEstimatedFreight] = useState(0)
  const [estimatedCommission, setEstimatedCommission] = useState(0)
  const [estimatedCustomsFee, setEstimatedCustomsFee] = useState(0)
  const [estimatedTax, setEstimatedTax] = useState(0)
  const [otherCosts, setOtherCosts] = useState(0)

  const [activeTab, setActiveTab] = useState('basic')

  useEffect(() => {
    getCustomers().then(setCustomers)
    getProducts().then(setProducts)
  }, [])

  // 计算
  const totalRevenue = items.reduce((s, item) => s + item.amount, 0)
  const subDocTotal = subDocs.reduce((s, sd) => s + sd.estimated_total, 0)
  const orderLevelTotal = estimatedFreight + estimatedCommission + estimatedCustomsFee + estimatedTax + otherCosts
  const totalCost = subDocTotal + orderLevelTotal
  const estimatedProfit = totalRevenue - totalCost
  const estimatedMargin = totalRevenue > 0 ? ((estimatedProfit / totalRevenue) * 100) : 0

  // 产品明细操作
  const addItem = () => setItems([...items, { product_id: '', product_name: '', sku: '', qty: 0, unit: 'PCS', unit_price: 0, amount: 0 }])
  const removeItem = (i: number) => { if (items.length > 1) setItems(items.filter((_, idx) => idx !== i)) }
  const updateItem = (index: number, field: string, value: string | number) => {
    const newItems = [...items]
    const item = { ...newItems[index] }
    if (field === 'product_id') {
      const product = products.find(p => p.id === value)
      if (product) { item.product_id = product.id; item.product_name = product.name; item.sku = product.sku; item.unit = product.unit; item.unit_price = product.default_price || 0; item.amount = item.qty * item.unit_price }
    } else if (field === 'qty') { item.qty = Number(value) || 0; item.amount = item.qty * item.unit_price }
    else if (field === 'unit_price') { item.unit_price = Number(value) || 0; item.amount = item.qty * item.unit_price }
    newItems[index] = item
    setItems(newItems)
  }

  // 子单据操作
  const addSubDoc = (type: SubDocumentType) => setSubDocs([...subDocs, newSubDoc(type)])
  const removeSubDoc = (id: string) => setSubDocs(subDocs.filter(sd => sd.id !== id))
  const updateSubDoc = (id: string, field: string, value: unknown) => {
    setSubDocs(subDocs.map(sd => sd.id === id ? { ...sd, [field]: value } : sd))
  }
  const addSubDocItem = (id: string) => {
    setSubDocs(subDocs.map(sd => sd.id === id ? { ...sd, items: [...sd.items, emptySubDocItem()] } : sd))
  }
  const updateSubDocItem = (docId: string, itemIdx: number, field: string, value: string | number) => {
    setSubDocs(subDocs.map(sd => {
      if (sd.id !== docId) return sd
      const newItems = [...sd.items]
      const item = { ...newItems[itemIdx] }
      if (field === 'qty') { item.qty = Number(value) || 0; item.amount = item.qty * item.unit_price }
      else if (field === 'unit_price') { item.unit_price = Number(value) || 0; item.amount = item.qty * item.unit_price }
      else { (item as Record<string, unknown>)[field] = value }
      newItems[itemIdx] = item
      const estimated_total = newItems.reduce((s, i) => s + i.amount, 0)
      return { ...sd, items: newItems, estimated_total }
    }))
  }
  const removeSubDocItem = (docId: string, itemIdx: number) => {
    setSubDocs(subDocs.map(sd => {
      if (sd.id !== docId || sd.items.length <= 1) return sd
      const newItems = sd.items.filter((_, i) => i !== itemIdx)
      return { ...sd, items: newItems, estimated_total: newItems.reduce((s, i) => s + i.amount, 0) }
    }))
  }

  // AI建议
  const handleAISuggest = () => {
    if (totalRevenue > 0) {
      setEstimatedFreight(Math.round(totalRevenue * 0.055))
      setEstimatedCommission(Math.round(totalRevenue * 0.05))
      setEstimatedCustomsFee(Math.round(totalRevenue * 0.015))
      setEstimatedTax(Math.round(totalRevenue * 0.02))
      setOtherCosts(Math.round(totalRevenue * 0.01))
      // 如果还没有子单据金额，也建议
      if (subDocTotal === 0) {
        setSubDocs(subDocs.map(sd => {
          if (sd.doc_type === 'raw_material') return { ...sd, estimated_total: Math.round(totalRevenue * 0.45) }
          if (sd.doc_type === 'factory_processing') return { ...sd, estimated_total: Math.round(totalRevenue * 0.2) }
          return sd
        }))
      }
      toast.success('AI已填充建议费用')
    }
  }

  // 保存
  const handleSave = async (submitForReview: boolean) => {
    if (!customerId) { toast.error('请选择客户'); return }
    if (totalRevenue <= 0) { toast.error('请添加产品明细'); return }

    setSaving(true)
    const { error } = await createBudgetOrder({
      customer_id: customerId, order_date: orderDate, delivery_date: deliveryDate || undefined,
      items, target_purchase_price: subDocTotal,
      estimated_freight: estimatedFreight, estimated_commission: estimatedCommission,
      estimated_customs_fee: estimatedCustomsFee, other_costs: otherCosts + estimatedTax,
      total_revenue: totalRevenue, total_cost: totalCost,
      estimated_profit: estimatedProfit, estimated_margin: Number(estimatedMargin.toFixed(2)),
      currency, exchange_rate: Number(exchangeRate),
      status: submitForReview ? 'pending_review' : 'draft',
      notes: [quoteNo && `报价单号: ${quoteNo}`, poNo && `PO号: ${poNo}`, notes].filter(Boolean).join('\n') || undefined,
    })
    setSaving(false)
    if (error) { toast.error(`保存失败: ${error}`); return }
    toast.success(submitForReview ? '预算单已提交审批' : '草稿已保存')
    router.push('/orders')
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="创建预算单" subtitle="报价单 → 客户PO → 预算子单据 → 审批" />

      <div className="flex-1 p-4 md:p-6 overflow-y-auto">
        <Link href="/orders"><Button variant="ghost" size="sm" className="mb-4"><ArrowLeft className="h-4 w-4 mr-1" />返回列表</Button></Link>

        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
          {/* 左侧：主内容区 */}
          <div className="xl:col-span-3 space-y-6">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList className="flex-wrap">
                <TabsTrigger value="basic">基本信息</TabsTrigger>
                <TabsTrigger value="products">产品明细 ({items.length})</TabsTrigger>
                <TabsTrigger value="subdocs">预算子单据 ({subDocs.length})</TabsTrigger>
                <TabsTrigger value="ordercosts">订单级费用</TabsTrigger>
              </TabsList>

              {/* Tab 1: 基本信息 */}
              <TabsContent value="basic" className="mt-4">
                <Card>
                  <CardContent className="pt-6 space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="col-span-2 space-y-2">
                        <Label>客户 *</Label>
                        <Select value={customerId} onValueChange={(v) => setCustomerId(v ?? '')}>
                          <SelectTrigger><SelectValue placeholder="选择客户" /></SelectTrigger>
                          <SelectContent>
                            {customers.map(c => <SelectItem key={c.id} value={c.id}>{c.company} ({c.country})</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>报价单号</Label>
                        <Input placeholder="Q-2026-001" value={quoteNo} onChange={e => setQuoteNo(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>客户PO号</Label>
                        <Input placeholder="PO-12345" value={poNo} onChange={e => setPoNo(e.target.value)} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="space-y-2">
                        <Label>下单日期</Label>
                        <Input type="date" value={orderDate} onChange={e => setOrderDate(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>交货日期</Label>
                        <Input type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>币种</Label>
                        <Select value={currency} onValueChange={(v) => setCurrency(v ?? 'USD')}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="USD">USD</SelectItem>
                            <SelectItem value="EUR">EUR</SelectItem>
                            <SelectItem value="GBP">GBP</SelectItem>
                            <SelectItem value="CNY">CNY</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>汇率</Label>
                        <Input type="number" step="0.01" value={exchangeRate} onChange={e => setExchangeRate(e.target.value)} />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>备注</Label>
                      <Textarea placeholder="贸易条款、特殊要求..." value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Tab 2: 产品明细 */}
              <TabsContent value="products" className="mt-4">
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">客户订单产品（销售收入）</CardTitle>
                      <Button variant="outline" size="sm" onClick={addItem}><Plus className="h-4 w-4 mr-1" />添加产品</Button>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0 overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[200px]">产品</TableHead>
                          <TableHead className="text-right w-[100px]">数量</TableHead>
                          <TableHead className="w-[60px]">单位</TableHead>
                          <TableHead className="text-right w-[120px]">单价({currency})</TableHead>
                          <TableHead className="text-right w-[120px]">金额({currency})</TableHead>
                          <TableHead className="w-[40px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((item, idx) => (
                          <TableRow key={idx}>
                            <TableCell>
                              <Select value={item.product_id} onValueChange={(v) => updateItem(idx, 'product_id', v ?? '')}>
                                <SelectTrigger className="h-8"><SelectValue placeholder="选择产品" /></SelectTrigger>
                                <SelectContent>{products.map(p => <SelectItem key={p.id} value={p.id}>{p.sku} - {p.name}</SelectItem>)}</SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell><Input type="number" className="h-8 text-right" value={item.qty || ''} onChange={e => updateItem(idx, 'qty', e.target.value)} /></TableCell>
                            <TableCell className="text-sm text-muted-foreground">{item.unit}</TableCell>
                            <TableCell><Input type="number" step="0.01" className="h-8 text-right" value={item.unit_price || ''} onChange={e => updateItem(idx, 'unit_price', e.target.value)} /></TableCell>
                            <TableCell className="text-right font-medium">{currency} {item.amount.toLocaleString()}</TableCell>
                            <TableCell><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeItem(idx)} disabled={items.length === 1}><Trash2 className="h-3.5 w-3.5 text-muted-foreground" /></Button></TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/50 font-semibold">
                          <TableCell colSpan={4} className="text-right">销售收入合计</TableCell>
                          <TableCell className="text-right">{currency} {totalRevenue.toLocaleString()}</TableCell>
                          <TableCell />
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Tab 3: 预算子单据 */}
              <TabsContent value="subdocs" className="mt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">每个子单据对应一个采购/加工环节，独立跟踪预算vs实际</p>
                  <Select onValueChange={(v) => { if (v) addSubDoc(v as SubDocumentType) }}>
                    <SelectTrigger className="w-48"><SelectValue placeholder="+ 添加子单据" /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(SUB_DOC_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                {subDocs.map(sd => (
                  <Card key={sd.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">{SUB_DOC_LABELS[sd.doc_type]}</Badge>
                          {sd.supplier_name && <span className="text-sm text-muted-foreground">— {sd.supplier_name}</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{currency} {sd.estimated_total.toLocaleString()}</span>
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeSubDoc(sd.id)}>
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">供应商/工厂</Label>
                          <Input className="h-8" placeholder="供应商名称" value={sd.supplier_name} onChange={e => updateSubDoc(sd.id, 'supplier_name', e.target.value)} />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">预算金额 ({currency})</Label>
                          <Input className="h-8" type="number" value={sd.estimated_total || ''} onChange={e => updateSubDoc(sd.id, 'estimated_total', Number(e.target.value) || 0)} />
                        </div>
                      </div>

                      {/* 子单据明细行 */}
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">名称/品名</TableHead>
                            <TableHead className="text-xs">规格</TableHead>
                            <TableHead className="text-xs text-right">数量</TableHead>
                            <TableHead className="text-xs">单位</TableHead>
                            <TableHead className="text-xs text-right">单价</TableHead>
                            <TableHead className="text-xs text-right">金额</TableHead>
                            <TableHead className="w-8"></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {sd.items.map((item, idx) => (
                            <TableRow key={idx}>
                              <TableCell><Input className="h-7 text-xs" value={item.name} onChange={e => updateSubDocItem(sd.id, idx, 'name', e.target.value)} placeholder="品名" /></TableCell>
                              <TableCell><Input className="h-7 text-xs" value={item.specification || ''} onChange={e => updateSubDocItem(sd.id, idx, 'specification', e.target.value)} placeholder="规格" /></TableCell>
                              <TableCell><Input type="number" className="h-7 text-xs text-right" value={item.qty || ''} onChange={e => updateSubDocItem(sd.id, idx, 'qty', e.target.value)} /></TableCell>
                              <TableCell><Input className="h-7 text-xs w-12" value={item.unit} onChange={e => updateSubDocItem(sd.id, idx, 'unit', e.target.value)} /></TableCell>
                              <TableCell><Input type="number" step="0.01" className="h-7 text-xs text-right" value={item.unit_price || ''} onChange={e => updateSubDocItem(sd.id, idx, 'unit_price', e.target.value)} /></TableCell>
                              <TableCell className="text-right text-xs font-medium">{item.amount.toLocaleString()}</TableCell>
                              <TableCell><Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeSubDocItem(sd.id, idx)} disabled={sd.items.length <= 1}><Trash2 className="h-3 w-3" /></Button></TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      <Button variant="ghost" size="sm" className="text-xs" onClick={() => addSubDocItem(sd.id)}>
                        <Plus className="h-3 w-3 mr-1" />添加明细行
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </TabsContent>

              {/* Tab 4: 订单级费用 */}
              <TabsContent value="ordercosts" className="mt-4">
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">订单级费用（不分配到子单据）</CardTitle>
                      <Button variant="outline" size="sm" onClick={handleAISuggest}><Sparkles className="h-3.5 w-3.5 mr-1" />AI建议</Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      <div className="space-y-2"><Label>运费 ({currency})</Label><Input type="number" value={estimatedFreight || ''} onChange={e => setEstimatedFreight(Number(e.target.value) || 0)} /></div>
                      <div className="space-y-2"><Label>佣金 ({currency})</Label><Input type="number" value={estimatedCommission || ''} onChange={e => setEstimatedCommission(Number(e.target.value) || 0)} /></div>
                      <div className="space-y-2"><Label>报关费 ({currency})</Label><Input type="number" value={estimatedCustomsFee || ''} onChange={e => setEstimatedCustomsFee(Number(e.target.value) || 0)} /></div>
                      <div className="space-y-2"><Label>预算税费 ({currency})</Label><Input type="number" value={estimatedTax || ''} onChange={e => setEstimatedTax(Number(e.target.value) || 0)} /></div>
                      <div className="space-y-2"><Label>其他费用 ({currency})</Label><Input type="number" value={otherCosts || ''} onChange={e => setOtherCosts(Number(e.target.value) || 0)} /></div>
                    </div>
                    <Separator />
                    <div className="flex justify-between text-sm font-semibold">
                      <span>订单级费用合计</span>
                      <span>{currency} {orderLevelTotal.toLocaleString()}</span>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>

          {/* 右侧：利润预览 + 操作 */}
          <div className="space-y-4">
            {/* 成本构成 */}
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-sm">成本构成</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {subDocs.map(sd => (
                  <div key={sd.id} className="flex justify-between">
                    <span className="text-muted-foreground truncate max-w-[140px]">{SUB_DOC_LABELS[sd.doc_type]}</span>
                    <span>{currency} {sd.estimated_total.toLocaleString()}</span>
                  </div>
                ))}
                <Separator />
                <div className="flex justify-between"><span className="text-muted-foreground">子单据小计</span><span className="font-medium">{currency} {subDocTotal.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">运费</span><span>{currency} {estimatedFreight.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">佣金</span><span>{currency} {estimatedCommission.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">报关费</span><span>{currency} {estimatedCustomsFee.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">税费</span><span>{currency} {estimatedTax.toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">其他</span><span>{currency} {otherCosts.toLocaleString()}</span></div>
                <Separator />
                <div className="flex justify-between font-semibold"><span>总成本</span><span>{currency} {totalCost.toLocaleString()}</span></div>
              </CardContent>
            </Card>

            {/* 利润预览 */}
            <Card className={estimatedProfit < 0 ? 'border-red-200 bg-red-50/50' : estimatedMargin < 15 ? 'border-amber-200 bg-amber-50/50' : 'border-green-200 bg-green-50/50'}>
              <CardContent className="pt-6 space-y-3">
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">预计利润</p>
                  <p className={`text-3xl font-bold mt-1 ${estimatedProfit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {currency} {estimatedProfit.toLocaleString()}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="p-2 bg-white/60 rounded-lg">
                    <p className="text-[10px] text-muted-foreground">总收入</p>
                    <p className="text-sm font-semibold">{currency} {totalRevenue.toLocaleString()}</p>
                  </div>
                  <div className="p-2 bg-white/60 rounded-lg">
                    <p className="text-[10px] text-muted-foreground">毛利率</p>
                    <p className={`text-sm font-semibold ${estimatedMargin < 0 ? 'text-red-600' : estimatedMargin < 15 ? 'text-amber-600' : 'text-green-600'}`}>
                      {estimatedMargin.toFixed(2)}%
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 操作按钮 */}
            <div className="space-y-2">
              <Button className="w-full" size="lg" disabled={saving} onClick={() => handleSave(true)}>
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                {saving ? '保存中...' : '保存并提交审批'}
              </Button>
              <Button variant="outline" className="w-full" disabled={saving} onClick={() => handleSave(false)}>
                <Save className="h-4 w-4 mr-2" />保存草稿
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
