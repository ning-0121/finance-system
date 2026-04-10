'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Plus, Loader2, Receipt, TrendingUp, Package, Ship, FileText, DollarSign, Upload } from 'lucide-react'
import { ExcelImportDialog } from '@/components/import/ExcelImportDialog'
import { toast } from 'sonner'
import { getBudgetOrders } from '@/lib/supabase/queries'
import { createClient } from '@/lib/supabase/client'
import type { BudgetOrder, CostType } from '@/lib/types'

const costTypeConfig: Record<CostType, { label: string; icon: typeof Ship; color: string }> = {
  freight: { label: '运费', icon: Ship, color: 'bg-blue-100 text-blue-700' },
  commission: { label: '佣金', icon: DollarSign, color: 'bg-green-100 text-green-700' },
  customs: { label: '报关费', icon: FileText, color: 'bg-purple-100 text-purple-700' },
  procurement: { label: '采购成本', icon: Package, color: 'bg-amber-100 text-amber-700' },
  other: { label: '其他', icon: Receipt, color: 'bg-gray-100 text-gray-700' },
}

interface CostRecord {
  id: string
  budget_order_id: string | null
  order_no?: string
  cost_type: CostType
  description: string
  amount: number
  currency: string
  exchange_rate: number
  created_at: string
}

// 演示费用数据
const demoCostItems: CostRecord[] = [
  { id: 'ci-1', budget_order_id: 'bo-1', order_no: 'BO-202604-0001', cost_type: 'freight', description: '深圳-洛杉矶 海运费 20GP', amount: 3450, currency: 'USD', exchange_rate: 7.24, created_at: '2026-04-05T10:00:00Z' },
  { id: 'ci-2', budget_order_id: 'bo-1', order_no: 'BO-202604-0001', cost_type: 'commission', description: '销售佣金 5%', amount: 2925, currency: 'USD', exchange_rate: 7.24, created_at: '2026-04-05T10:05:00Z' },
  { id: 'ci-3', budget_order_id: 'bo-1', order_no: 'BO-202604-0001', cost_type: 'customs', description: '报关+检验检疫', amount: 750, currency: 'USD', exchange_rate: 7.24, created_at: '2026-04-06T09:00:00Z' },
  { id: 'ci-4', budget_order_id: 'bo-1', order_no: 'BO-202604-0001', cost_type: 'procurement', description: 'LED灯带+面板灯采购款', amount: 39200, currency: 'USD', exchange_rate: 7.24, created_at: '2026-04-03T14:00:00Z' },
  { id: 'ci-5', budget_order_id: 'bo-4', order_no: 'BO-202603-0005', cost_type: 'freight', description: '深圳-洛杉矶 拼柜运费', amount: 2100, currency: 'USD', exchange_rate: 7.22, created_at: '2026-03-28T11:00:00Z' },
  { id: 'ci-6', budget_order_id: 'bo-4', order_no: 'BO-202603-0005', cost_type: 'other', description: '包装材料+打托', amount: 250, currency: 'USD', exchange_rate: 7.22, created_at: '2026-03-27T16:00:00Z' },
  { id: 'ci-7', budget_order_id: null, order_no: undefined, cost_type: 'other', description: '办公室快递费（待归集）', amount: 120, currency: 'CNY', exchange_rate: 1, created_at: '2026-04-08T15:00:00Z' },
]

export default function CostsPage() {
  const [costItems, setCostItems] = useState<CostRecord[]>(demoCostItems)
  const [orders, setOrders] = useState<BudgetOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('all')

  // 新费用表单
  const [formType, setFormType] = useState<CostType>('freight')
  const [formOrderId, setFormOrderId] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formAmount, setFormAmount] = useState('')
  const [formCurrency, setFormCurrency] = useState('USD')
  const [formRate, setFormRate] = useState('7.24')

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const ordersData = await getBudgetOrders()
        setOrders(ordersData)

        // 尝试从Supabase加载费用
        const supabase = createClient()
        const { data } = await supabase
          .from('cost_items')
          .select('*, budget_orders(order_no)')
          .order('created_at', { ascending: false })

        if (data && data.length > 0) {
          setCostItems(data.map((r: Record<string, unknown>) => ({
            id: r.id as string,
            budget_order_id: r.budget_order_id as string | null,
            order_no: (r.budget_orders as Record<string, unknown>)?.order_no as string | undefined,
            cost_type: r.cost_type as CostType,
            description: r.description as string,
            amount: r.amount as number,
            currency: r.currency as string,
            exchange_rate: r.exchange_rate as number,
            created_at: r.created_at as string,
          })))
        }
      } catch {
        // fallback to demo
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const filteredItems = tab === 'all'
    ? costItems
    : tab === 'unlinked'
    ? costItems.filter(c => !c.budget_order_id)
    : costItems.filter(c => c.cost_type === tab)

  // 统计
  const totalAmount = costItems.reduce((s, c) => s + c.amount, 0)
  const unlinkedCount = costItems.filter(c => !c.budget_order_id).length
  const byType = Object.entries(costTypeConfig).map(([type, cfg]) => {
    const items = costItems.filter(c => c.cost_type === type)
    return { type, ...cfg, count: items.length, total: items.reduce((s, c) => s + c.amount, 0) }
  }).filter(t => t.count > 0)

  const handleSave = async () => {
    if (!formDesc.trim()) { toast.error('请输入费用描述'); return }
    if (!formAmount || Number(formAmount) <= 0) { toast.error('请输入有效金额'); return }

    setSaving(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('cost_items')
        .insert({
          budget_order_id: formOrderId || null,
          cost_type: formType,
          description: formDesc,
          amount: Number(formAmount),
          currency: formCurrency,
          exchange_rate: Number(formRate),
          created_by: '00000000-0000-0000-0000-000000000000',
        })
        .select('*, budget_orders(order_no)')
        .single()

      if (error) throw error

      const newItem: CostRecord = {
        id: data.id,
        budget_order_id: data.budget_order_id,
        order_no: data.budget_orders?.order_no,
        cost_type: data.cost_type,
        description: data.description,
        amount: data.amount,
        currency: data.currency,
        exchange_rate: data.exchange_rate,
        created_at: data.created_at,
      }
      setCostItems([newItem, ...costItems])
      toast.success('费用已录入')
    } catch {
      // Demo mode fallback
      const newItem: CostRecord = {
        id: `ci-${Date.now()}`,
        budget_order_id: formOrderId || null,
        order_no: orders.find(o => o.id === formOrderId)?.order_no,
        cost_type: formType,
        description: formDesc,
        amount: Number(formAmount),
        currency: formCurrency,
        exchange_rate: Number(formRate),
        created_at: new Date().toISOString(),
      }
      setCostItems([newItem, ...costItems])
      toast.success('费用已录入（演示模式）')
    } finally {
      setSaving(false)
      setShowAdd(false)
      setFormDesc('')
      setFormAmount('')
      setFormOrderId('')
    }
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="费用归集" subtitle="运费·佣金·报关费自动挂靠订单，杜绝漏算" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-50"><Receipt className="h-4 w-4 text-blue-600" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">总费用笔数</p>
                  <p className="text-xl font-bold">{costItems.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-50"><TrendingUp className="h-4 w-4 text-green-600" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">总金额</p>
                  <p className="text-xl font-bold">${totalAmount.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-50"><Package className="h-4 w-4 text-amber-600" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">已归集</p>
                  <p className="text-xl font-bold">{costItems.length - unlinkedCount}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className={unlinkedCount > 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${unlinkedCount > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <Receipt className={`h-4 w-4 ${unlinkedCount > 0 ? 'text-red-600' : 'text-gray-400'}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">待归集</p>
                  <p className={`text-xl font-bold ${unlinkedCount > 0 ? 'text-red-600' : ''}`}>{unlinkedCount}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Type breakdown */}
        <div className="flex gap-2 flex-wrap">
          {byType.map(t => (
            <Badge key={t.type} variant="outline" className={`${t.color} border-0 cursor-pointer`} onClick={() => setTab(t.type)}>
              <t.icon className="h-3 w-3 mr-1" />{t.label}: {t.count}笔 ${t.total.toLocaleString()}
            </Badge>
          ))}
        </div>

        {/* Actions + Table */}
        <div className="flex items-center justify-between">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="all">全部 ({costItems.length})</TabsTrigger>
              <TabsTrigger value="unlinked" className={unlinkedCount > 0 ? 'text-red-600' : ''}>
                待归集 ({unlinkedCount})
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowImport(true)}>
              <Upload className="h-4 w-4 mr-1" />批量导入
            </Button>
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus className="h-4 w-4 mr-1" />录入费用
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>类型</TableHead>
                    <TableHead>描述</TableHead>
                    <TableHead>关联订单</TableHead>
                    <TableHead className="text-right">金额</TableHead>
                    <TableHead>币种</TableHead>
                    <TableHead>汇率</TableHead>
                    <TableHead>日期</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map(item => {
                    const cfg = costTypeConfig[item.cost_type]
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Badge variant="outline" className={`${cfg.color} border-0`}>
                            {cfg.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[250px]">{item.description}</TableCell>
                        <TableCell>
                          {item.order_no ? (
                            <span className="text-primary font-medium">{item.order_no}</span>
                          ) : (
                            <Badge variant="destructive" className="text-[10px]">待归集</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-semibold">{item.amount.toLocaleString()}</TableCell>
                        <TableCell>{item.currency}</TableCell>
                        <TableCell>{item.exchange_rate}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(item.created_at).toLocaleDateString('zh-CN')}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {filteredItems.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">暂无费用记录</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 批量导入弹窗 */}
      <ExcelImportDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onSuccess={(count) => toast.success(`成功导入 ${count} 条费用记录`)}
      />

      {/* 录入费用弹窗 */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>录入费用</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>费用类型</Label>
                <Select value={formType} onValueChange={(v) => setFormType((v || 'freight') as CostType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(costTypeConfig).map(([key, cfg]) => (
                      <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>关联订单</Label>
                <Select value={formOrderId} onValueChange={(v) => setFormOrderId(v || '')}>
                  <SelectTrigger><SelectValue placeholder="选择订单（可选）" /></SelectTrigger>
                  <SelectContent>
                    {orders.map(o => (
                      <SelectItem key={o.id} value={o.id}>{o.order_no} - {o.customer?.company || ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>费用描述 *</Label>
              <Textarea placeholder="例：深圳-洛杉矶 海运费 20GP" value={formDesc} onChange={e => setFormDesc(e.target.value)} rows={2} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>金额 *</Label>
                <Input type="number" step="0.01" placeholder="0.00" value={formAmount} onChange={e => setFormAmount(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>币种</Label>
                <Select value={formCurrency} onValueChange={(v) => setFormCurrency(v || 'USD')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                    <SelectItem value="CNY">CNY</SelectItem>
                    <SelectItem value="GBP">GBP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>汇率</Label>
                <Input type="number" step="0.01" value={formRate} onChange={e => setFormRate(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>取消</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />保存中...</> : '确认录入'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
