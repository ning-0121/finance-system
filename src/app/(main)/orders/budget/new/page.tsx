'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { demoCustomers, demoProducts } from '@/lib/demo-data'
import { ArrowLeft, Plus, Trash2, Sparkles, Save, Send } from 'lucide-react'
import Link from 'next/link'
import type { OrderItem } from '@/lib/types'

export default function NewBudgetOrderPage() {
  const router = useRouter()
  const [customerId, setCustomerId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [exchangeRate, setExchangeRate] = useState('7.24')
  const [orderDate, setOrderDate] = useState(new Date().toISOString().split('T')[0])
  const [deliveryDate, setDeliveryDate] = useState('')
  const [notes, setNotes] = useState('')

  const [items, setItems] = useState<OrderItem[]>([
    { product_id: '', product_name: '', sku: '', qty: 0, unit: 'PCS', unit_price: 0, amount: 0 },
  ])

  const [targetPurchasePrice, setTargetPurchasePrice] = useState(0)
  const [estimatedFreight, setEstimatedFreight] = useState(0)
  const [estimatedCommission, setEstimatedCommission] = useState(0)
  const [estimatedCustomsFee, setEstimatedCustomsFee] = useState(0)
  const [otherCosts, setOtherCosts] = useState(0)

  const totalRevenue = items.reduce((sum, item) => sum + item.amount, 0)
  const totalCost = targetPurchasePrice + estimatedFreight + estimatedCommission + estimatedCustomsFee + otherCosts
  const estimatedProfit = totalRevenue - totalCost
  const estimatedMargin = totalRevenue > 0 ? ((estimatedProfit / totalRevenue) * 100) : 0

  const addItem = () => {
    setItems([...items, { product_id: '', product_name: '', sku: '', qty: 0, unit: 'PCS', unit_price: 0, amount: 0 }])
  }

  const removeItem = (index: number) => {
    if (items.length > 1) {
      setItems(items.filter((_, i) => i !== index))
    }
  }

  const updateItem = (index: number, field: keyof OrderItem, value: string | number) => {
    const newItems = [...items]
    const item = { ...newItems[index] }

    if (field === 'product_id') {
      const product = demoProducts.find(p => p.id === value)
      if (product) {
        item.product_id = product.id
        item.product_name = product.name
        item.sku = product.sku
        item.unit = product.unit
        item.unit_price = product.default_price || 0
        item.amount = item.qty * item.unit_price
      }
    } else if (field === 'qty') {
      item.qty = Number(value) || 0
      item.amount = item.qty * item.unit_price
    } else if (field === 'unit_price') {
      item.unit_price = Number(value) || 0
      item.amount = item.qty * item.unit_price
    } else {
      (item as Record<string, unknown>)[field] = value
    }

    newItems[index] = item
    setItems(newItems)
  }

  const handleAISuggest = () => {
    // AI建议模拟 - 根据历史数据建议费用
    if (totalRevenue > 0) {
      setTargetPurchasePrice(Math.round(totalRevenue * 0.65))
      setEstimatedFreight(Math.round(totalRevenue * 0.055))
      setEstimatedCommission(Math.round(totalRevenue * 0.05))
      setEstimatedCustomsFee(Math.round(totalRevenue * 0.015))
      setOtherCosts(Math.round(totalRevenue * 0.01))
    }
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="创建预算单" subtitle="填写订单信息，预估成本和利润" />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        <Link href="/orders">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            返回列表
          </Button>
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Order Info + Items */}
          <div className="lg:col-span-2 space-y-6">
            {/* Basic Info */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">基本信息</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>客户 *</Label>
                    <Select value={customerId} onValueChange={(v) => setCustomerId(v ?? '')}>
                      <SelectTrigger>
                        <SelectValue placeholder="选择客户" />
                      </SelectTrigger>
                      <SelectContent>
                        {demoCustomers.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.company} ({c.country})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <Label>币种</Label>
                      <Select value={currency} onValueChange={(v) => setCurrency(v ?? 'USD')}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                          <SelectItem value="GBP">GBP</SelectItem>
                          <SelectItem value="JPY">JPY</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>汇率</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={exchangeRate}
                        onChange={(e) => setExchangeRate(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>下单日期</Label>
                    <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>交货日期</Label>
                    <Input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Items */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">产品明细</CardTitle>
                  <Button variant="outline" size="sm" onClick={addItem}>
                    <Plus className="h-4 w-4 mr-1" />
                    添加产品
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
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
                          <Select
                            value={item.product_id}
                            onValueChange={(v) => updateItem(idx, 'product_id', v ?? '')}
                          >
                            <SelectTrigger className="h-8">
                              <SelectValue placeholder="选择产品" />
                            </SelectTrigger>
                            <SelectContent>
                              {demoProducts.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.sku} - {p.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            className="h-8 text-right"
                            value={item.qty || ''}
                            onChange={(e) => updateItem(idx, 'qty', e.target.value)}
                          />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{item.unit}</TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            step="0.01"
                            className="h-8 text-right"
                            value={item.unit_price || ''}
                            onChange={(e) => updateItem(idx, 'unit_price', e.target.value)}
                          />
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {currency} {item.amount.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => removeItem(idx)}
                            disabled={items.length === 1}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="bg-muted/50 font-semibold">
                      <TableCell colSpan={4} className="text-right">合计</TableCell>
                      <TableCell className="text-right">{currency} {totalRevenue.toLocaleString()}</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* Notes */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">备注</CardTitle>
              </CardHeader>
              <CardContent>
                <Textarea
                  placeholder="贸易条款、特殊要求等..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                />
              </CardContent>
            </Card>
          </div>

          {/* Right: Cost & Profit */}
          <div className="space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">成本预估</CardTitle>
                  <Button variant="outline" size="sm" onClick={handleAISuggest}>
                    <Sparkles className="h-3.5 w-3.5 mr-1" />
                    AI建议
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>目标采购价 ({currency})</Label>
                  <Input
                    type="number"
                    value={targetPurchasePrice || ''}
                    onChange={(e) => setTargetPurchasePrice(Number(e.target.value) || 0)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>预估运费 ({currency})</Label>
                  <Input
                    type="number"
                    value={estimatedFreight || ''}
                    onChange={(e) => setEstimatedFreight(Number(e.target.value) || 0)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>预估佣金 ({currency})</Label>
                  <Input
                    type="number"
                    value={estimatedCommission || ''}
                    onChange={(e) => setEstimatedCommission(Number(e.target.value) || 0)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>预估报关费 ({currency})</Label>
                  <Input
                    type="number"
                    value={estimatedCustomsFee || ''}
                    onChange={(e) => setEstimatedCustomsFee(Number(e.target.value) || 0)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>其他费用 ({currency})</Label>
                  <Input
                    type="number"
                    value={otherCosts || ''}
                    onChange={(e) => setOtherCosts(Number(e.target.value) || 0)}
                  />
                </div>

                <Separator />

                <div className="flex justify-between text-sm font-semibold">
                  <span>总成本</span>
                  <span>{currency} {totalCost.toLocaleString()}</span>
                </div>
              </CardContent>
            </Card>

            {/* Profit Preview */}
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

            {/* Actions */}
            <div className="space-y-2">
              <Button className="w-full" size="lg">
                <Send className="h-4 w-4 mr-2" />
                保存并提交审批
              </Button>
              <Button variant="outline" className="w-full">
                <Save className="h-4 w-4 mr-2" />
                保存草稿
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
