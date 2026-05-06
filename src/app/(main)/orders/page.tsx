'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { BudgetStatusBadge } from '@/components/shared/StatusBadge'
import { getBudgetOrders } from '@/lib/supabase/queries'
import { Plus, Search, Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { exportBudgetOrdersToExcel } from '@/lib/excel'
import { exportProfitAnalysisReport } from '@/lib/excel/export-professional'
import type { BudgetOrder, BudgetOrderStatus } from '@/lib/types'

export default function OrdersPage() {
  const [orders, setOrders] = useState<BudgetOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  const [syncedMap, setSyncedMap] = useState<Record<string, { qmNo: string; internalNo: string; lifecycle?: string; customer?: string; qty?: number; unit?: string }>>({})
  const [syncing, setSyncing] = useState(false)

  // F3: 已确认决算的实际利润 / 实际毛利率（按 budget_order_id 索引）
  const [settlementMap, setSettlementMap] = useState<Record<string, { final_profit: number; final_margin: number; status: string }>>({})

  // F3: 排序状态
  const [sortBy, setSortBy] = useState<'created' | 'margin' | 'profit'>('created')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const loadOrders = async () => {
    setLoading(true)
    try {
      const data = await getBudgetOrders()
      setOrders(data)
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data: synced } = await supabase.from('synced_orders').select('budget_order_id, order_no, style_no, lifecycle_status, customer_name, quantity, quantity_unit').not('budget_order_id', 'is', null)
      if (synced) {
        const map: Record<string, { qmNo: string; internalNo: string; lifecycle?: string; customer?: string; qty?: number; unit?: string }> = {}
        synced.forEach((s: Record<string, unknown>) => {
          if (s.budget_order_id) map[s.budget_order_id as string] = {
            qmNo: s.order_no as string || '',
            internalNo: s.style_no as string || '',
            lifecycle: s.lifecycle_status as string || '',
            customer: s.customer_name as string || '',
            qty: s.quantity as number || 0,
            unit: s.quantity_unit as string || '件',
          }
        })
        setSyncedMap(map)
      }

      // F3: 加载所有已生成的 order_settlements，建立 budget_order_id → 实际数据 映射
      // 这样订单完结后能看到实际利润而不是预估
      try {
        const { data: settlements } = await supabase
          .from('order_settlements')
          .select('budget_order_id, final_profit, final_margin, status')
        if (settlements) {
          const sMap: Record<string, { final_profit: number; final_margin: number; status: string }> = {}
          settlements.forEach((s: Record<string, unknown>) => {
            if (s.budget_order_id) sMap[s.budget_order_id as string] = {
              final_profit: Number(s.final_profit) || 0,
              final_margin: Number(s.final_margin) || 0,
              status: (s.status as string) || 'draft',
            }
          })
          setSettlementMap(sMap)
        }
      } catch {
        // 决算表查询失败不阻塞列表渲染
      }
    } catch {
      toast.error('加载订单失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadOrders() }, [])

  const handleSync = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/integration/sync', { method: 'POST' })
      const result = await res.json()
      if (result.error) {
        toast.error(`同步失败: ${result.error}`)
      } else if (result.synced === 0) {
        toast.info('所有订单已是最新')
      } else {
        toast.success(`同步完成：新增 ${result.synced} 个订单，创建 ${result.created} 个预算单`)
        await loadOrders()
      }
    } catch {
      toast.error('同步请求失败')
    }
    setSyncing(false)
  }

  // F3: 取一笔订单的"有效"利润 / 毛利率（已确认决算 → 用实际，否则用预估）
  const getEffectiveProfit = (orderId: string, fallback: number) => {
    const s = settlementMap[orderId]
    return s && (s.status === 'confirmed' || s.status === 'locked') ? s.final_profit : fallback
  }
  const getEffectiveMargin = (orderId: string, fallback: number) => {
    const s = settlementMap[orderId]
    return s && (s.status === 'confirmed' || s.status === 'locked') ? s.final_margin : fallback
  }

  const filteredOrders = orders
    .filter((order) => {
      const matchesStatus = statusFilter === 'all' || order.status === statusFilter
      const matchesSearch = search === '' ||
        order.order_no.toLowerCase().includes(search.toLowerCase()) ||
        order.customer?.company?.toLowerCase().includes(search.toLowerCase()) ||
        (syncedMap[order.id]?.internalNo || '').toLowerCase().includes(search.toLowerCase()) ||
        (syncedMap[order.id]?.qmNo || '').toLowerCase().includes(search.toLowerCase())
      return matchesStatus && matchesSearch
    })
    .sort((a, b) => {
      // 默认按创建时间降序（保持原有行为）
      if (sortBy === 'created') return 0
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortBy === 'margin') {
        return (getEffectiveMargin(a.id, a.estimated_margin) - getEffectiveMargin(b.id, b.estimated_margin)) * dir
      }
      // sortBy === 'profit'
      return (getEffectiveProfit(a.id, a.estimated_profit) - getEffectiveProfit(b.id, b.estimated_profit)) * dir
    })

  const toggleSort = (col: 'margin' | 'profit') => {
    if (sortBy !== col) {
      setSortBy(col)
      setSortDir('desc')
    } else {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc')
    }
  }

  const statusCounts = {
    all: orders.length,
    draft: orders.filter(o => o.status === 'draft').length,
    pending_review: orders.filter(o => o.status === 'pending_review').length,
    approved: orders.filter(o => o.status === 'approved').length,
    closed: orders.filter(o => o.status === 'closed').length,
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="订单成本核算" subtitle="预算单 + 结算单双轨制管理" />

      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 flex-1">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="搜索订单号、客户..." className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={syncing} onClick={handleSync}>
              <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? '同步中...' : '从节拍器同步'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => {
              exportBudgetOrdersToExcel(filteredOrders)
              toast.success(`已导出 ${filteredOrders.length} 条订单`)
            }}>
              <Download className="h-4 w-4 mr-1" />简易导出
            </Button>
            <Button variant="outline" size="sm" onClick={() => {
              exportProfitAnalysisReport(filteredOrders)
              toast.success('利润分析表已导出')
            }}>
              <Download className="h-4 w-4 mr-1" />利润分析表
            </Button>
            <Link href="/orders/budget/new">
              <Button size="sm"><Plus className="h-4 w-4 mr-1" />创建预算单</Button>
            </Link>
          </div>
        </div>

        <Tabs value={statusFilter} onValueChange={setStatusFilter}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="all">全部 ({statusCounts.all})</TabsTrigger>
            <TabsTrigger value="draft">草稿 ({statusCounts.draft})</TabsTrigger>
            <TabsTrigger value="pending_review">待审批 ({statusCounts.pending_review})</TabsTrigger>
            <TabsTrigger value="approved">已通过 ({statusCounts.approved})</TabsTrigger>
            <TabsTrigger value="closed">已关闭 ({statusCounts.closed})</TabsTrigger>
          </TabsList>
        </Tabs>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground">加载中...</span>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>订单号</TableHead>
                    <TableHead>内部单号</TableHead>
                    <TableHead>客户</TableHead>
                    <TableHead className="text-right">合同金额</TableHead>
                    <TableHead className="text-right">成本(¥)</TableHead>
                    <TableHead
                      className="text-right cursor-pointer select-none hover:text-primary"
                      onClick={() => toggleSort('profit')}
                      title="点击按利润排序"
                    >
                      利润(¥) {sortBy === 'profit' && (sortDir === 'desc' ? '↓' : '↑')}
                    </TableHead>
                    <TableHead
                      className="text-right cursor-pointer select-none hover:text-primary"
                      onClick={() => toggleSort('margin')}
                      title="点击按毛利率排序"
                    >
                      毛利率 {sortBy === 'margin' && (sortDir === 'desc' ? '↓' : '↑')}
                    </TableHead>
                    <TableHead>财务状态</TableHead>
                    <TableHead>订单进度</TableHead>
                    <TableHead>下单日期</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredOrders.map((order) => (
                    <TableRow key={order.id} className="cursor-pointer hover:bg-muted/50">
                      <TableCell>
                        <Link href={`/orders/${order.id}`} className="text-primary hover:underline font-medium">{order.order_no}</Link>
                        {syncedMap[order.id]?.qmNo && <p className="text-[10px] text-muted-foreground">{syncedMap[order.id].qmNo}</p>}
                      </TableCell>
                      <TableCell className="font-mono text-sm">
                        {syncedMap[order.id]?.internalNo || '-'}
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="text-sm">{order.customer?.company || '-'}</p>
                          <p className="text-xs text-muted-foreground">{order.customer?.country || ''}</p>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">{order.currency === 'CNY' ? '¥' : '$'} {order.total_revenue.toLocaleString()}</TableCell>
                      <TableCell className="text-right">¥ {order.total_cost.toLocaleString()}</TableCell>
                      {/* F3: 利润 — 已确认决算时显示实际，否则显示预估，带"实"角标 */}
                      {(() => {
                        const sett = settlementMap[order.id]
                        const isActual = sett && (sett.status === 'confirmed' || sett.status === 'locked')
                        const profit = isActual ? sett.final_profit : order.estimated_profit
                        const margin = isActual ? sett.final_margin : order.estimated_margin
                        return (
                          <>
                            <TableCell className={`text-right font-semibold ${profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                              <div className="inline-flex items-center gap-1 justify-end">
                                {isActual && (
                                  <span className="text-[9px] font-bold bg-green-100 text-green-700 px-1 rounded" title="实际利润（决算已确认）">实</span>
                                )}
                                ¥ {profit.toLocaleString()}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                margin < 0 ? 'bg-red-100 text-red-700' : margin < 15 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                              }`}>
                                {isActual && (
                                  <span className="text-[9px] font-bold opacity-80" title="来自决算">实</span>
                                )}
                                {margin}%
                              </span>
                            </TableCell>
                          </>
                        )
                      })()}
                      <TableCell><BudgetStatusBadge status={order.status as BudgetOrderStatus} /></TableCell>
                      <TableCell>
                        {syncedMap[order.id]?.lifecycle && (
                          <Badge variant="outline" className={`text-[10px] ${syncedMap[order.id].lifecycle === '已完成' ? 'bg-green-50 text-green-700 border-green-200' : ''}`}>
                            {syncedMap[order.id].lifecycle}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{order.order_date}</TableCell>
                    </TableRow>
                  ))}
                  {filteredOrders.length === 0 && !loading && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">没有找到匹配的订单</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
