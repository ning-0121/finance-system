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
  fabric: { label: '面料', icon: Package, color: 'bg-rose-100 text-rose-700' },
  accessory: { label: '辅料', icon: Package, color: 'bg-pink-100 text-pink-700' },
  processing: { label: '加工费', icon: Receipt, color: 'bg-orange-100 text-orange-700' },
  freight: { label: '货代费', icon: Ship, color: 'bg-blue-100 text-blue-700' },
  container: { label: '装柜费', icon: Package, color: 'bg-cyan-100 text-cyan-700' },
  logistics: { label: '物流费', icon: Ship, color: 'bg-teal-100 text-teal-700' },
  commission: { label: '佣金', icon: DollarSign, color: 'bg-green-100 text-green-700' },
  customs: { label: '报关费', icon: FileText, color: 'bg-purple-100 text-purple-700' },
  procurement: { label: '其他采购', icon: Package, color: 'bg-amber-100 text-amber-700' },
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

// 空数据占位（不再显示假数据）
const demoCostItems: CostRecord[] = []

export default function CostsPage() {
  const [costItems, setCostItems] = useState<CostRecord[]>(demoCostItems)
  const [orders, setOrders] = useState<BudgetOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('all')

  // 新费用表单
  const [formType, setFormType] = useState<CostType>('fabric')
  const [formOrderId, setFormOrderId] = useState('')
  const [orderSearch, setOrderSearch] = useState('')
  const [showOrderList, setShowOrderList] = useState(false)
  const [formDesc, setFormDesc] = useState('')
  const [formAmount, setFormAmount] = useState('')
  const [formCurrency, setFormCurrency] = useState('CNY')
  const [formRate, setFormRate] = useState('1')

  const [syncedOrderMap, setSyncedOrderMap] = useState<Record<string, string>>({}) // budget_order_id → QM订单号

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const ordersData = await getBudgetOrders()
        setOrders(ordersData)

        // 加载synced_orders获取内部单号+QM号+客户映射
        const supabase2 = createClient()
        const { data: syncedOrders } = await supabase2.from('synced_orders').select('order_no, budget_order_id, style_no, customer_name').not('budget_order_id', 'is', null)
        if (syncedOrders) {
          const map: Record<string, string> = {}
          syncedOrders.forEach((s: Record<string, unknown>) => {
            if (s.budget_order_id) {
              const internal = s.style_no ? `${s.style_no} | ` : ''
              const customer = s.customer_name ? ` - ${s.customer_name}` : ''
              map[s.budget_order_id as string] = `${internal}${s.order_no as string}${customer}`
            }
          })
          setSyncedOrderMap(map)
        }

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
      const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
      const createdBy = profiles?.[0]?.id
      if (!createdBy) { toast.error('无法获取用户信息'); setSaving(false); return }

      // 1. 写入
      const { data, error } = await supabase
        .from('cost_items')
        .insert({
          budget_order_id: formOrderId || null,
          cost_type: formType,
          description: formDesc,
          amount: Number(formAmount),
          currency: formCurrency,
          exchange_rate: Number(formRate),
          supplier: formDesc.split(/[,，]/)[0]?.trim() || null,
          created_by: createdBy,
        })
        .select('*, budget_orders(order_no)')
        .single()

      if (error) throw error

      // 2. 写后验证：回读确认数据存在
      const { data: verify } = await supabase.from('cost_items').select('id').eq('id', data.id).single()
      if (!verify) {
        console.error('[SaveGuard] cost_items写后验证失败: id=', data.id)
        toast.error('保存异常：数据写入但回读失败，请刷新页面')
        setSaving(false)
        return
      }

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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('cost_type')) toast.error('费用类型不支持，请刷新页面后重试')
      else if (msg.includes('foreign key')) toast.error('关联的订单不存在，请检查')
      else if (msg.includes('not-null')) toast.error('必填字段为空')
      else toast.error(`保存失败: ${msg}`)
      console.error('[费用录入失败]', msg, { formType, formAmount, formCurrency, formRate, formOrderId })
      setSaving(false)
      return // 失败时不关闭弹窗，保留用户输入
    }
    // 成功后才关闭弹窗并清空表单
    setSaving(false)
    setShowAdd(false)
    setFormDesc('')
    setFormAmount('')
    setFormOrderId('')
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="费用归集" subtitle="面料·辅料·加工费·货代·装柜·物流·佣金，所有实际费用归集到订单" />

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
                  <p className="text-xl font-bold">¥{totalAmount.toLocaleString()}</p>
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
              <t.icon className="h-3 w-3 mr-1" />{t.label}: {t.count}笔 ¥{t.total.toLocaleString()}
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
                    <TableHead className="text-center">操作</TableHead>
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
                        <TableCell className="text-center">
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500 hover:text-red-700" onClick={async () => {
                            if (!confirm(`确定删除这笔费用？\n${item.description}\n金额: ${item.amount}`)) return
                            try {
                              const supabase = createClient()
                              const { error } = await supabase.from('cost_items').delete().eq('id', item.id)
                              if (error) throw error
                              setCostItems(costItems.filter(c => c.id !== item.id))
                              toast.success('已删除')
                            } catch (err) { toast.error(`删除失败: ${err instanceof Error ? err.message : '未知错误'}`) }
                          }}>删除</Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {filteredItems.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">暂无费用记录</TableCell>
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
                <Label>关联订单（输入搜索）</Label>
                <div className="relative">
                  <Input
                    placeholder="输入内部单号/订单号/客户名搜索..."
                    value={formOrderId ? (syncedOrderMap[formOrderId] || orders.find(o => o.id === formOrderId)?.order_no || formOrderId) : orderSearch}
                    onChange={(e) => { setOrderSearch(e.target.value); setFormOrderId('') }}
                    onFocus={() => setShowOrderList(true)}
                  />
                  {showOrderList && (
                    <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border rounded-lg shadow-lg max-h-[200px] overflow-y-auto">
                      {orders
                        .filter(o => {
                          if (!orderSearch) return true
                          const label = syncedOrderMap[o.id] || o.order_no
                          return label.toLowerCase().includes(orderSearch.toLowerCase()) || (o.customer?.company || '').toLowerCase().includes(orderSearch.toLowerCase())
                        })
                        .slice(0, 20)
                        .map(o => {
                          const label = syncedOrderMap[o.id] || o.order_no
                          return (
                            <button key={o.id} className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors" onClick={() => { setFormOrderId(o.id); setOrderSearch(''); setShowOrderList(false) }}>
                              {label}
                            </button>
                          )
                        })}
                      {orders.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">暂无订单</p>}
                    </div>
                  )}
                </div>
                {formOrderId && <button className="text-xs text-muted-foreground hover:text-red-500" onClick={() => setFormOrderId('')}>清除关联</button>}
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
                <Select value={formCurrency} onValueChange={(v) => {
                  const cur = v || 'USD'
                  setFormCurrency(cur)
                  if (cur === 'CNY') setFormRate('1')
                  else if (cur === 'USD') setFormRate('6.9')
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CNY">人民币 CNY</SelectItem>
                    <SelectItem value="USD">美元 USD</SelectItem>
                    <SelectItem value="EUR">欧元 EUR</SelectItem>
                    <SelectItem value="GBP">英镑 GBP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{formCurrency === 'CNY' ? '汇率（人民币无需填）' : '汇率'}</Label>
                <Input type="number" step="0.01" value={formRate} onChange={e => setFormRate(e.target.value)} disabled={formCurrency === 'CNY'} />
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
