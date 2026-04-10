'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { BudgetStatusBadge } from '@/components/shared/StatusBadge'
import { demoBudgetOrders } from '@/lib/demo-data'
import { Plus, Search, Download, Filter } from 'lucide-react'
import type { BudgetOrderStatus } from '@/lib/types'

export default function OrdersPage() {
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  const filteredOrders = demoBudgetOrders.filter((order) => {
    const matchesStatus = statusFilter === 'all' || order.status === statusFilter
    const matchesSearch = search === '' ||
      order.order_no.toLowerCase().includes(search.toLowerCase()) ||
      order.customer?.company.toLowerCase().includes(search.toLowerCase())
    return matchesStatus && matchesSearch
  })

  return (
    <div className="flex flex-col h-full">
      <Header title="订单成本核算" subtitle="预算单 + 结算单双轨制管理" />

      <div className="flex-1 p-6 space-y-4 overflow-y-auto">
        {/* Actions Bar */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="搜索订单号、客户..."
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button variant="outline" size="sm">
              <Filter className="h-4 w-4 mr-1" />
              筛选
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => toast.success('导出成功', { description: `已导出 ${filteredOrders.length} 条订单数据` })}>
              <Download className="h-4 w-4 mr-1" />
              导出
            </Button>
            <Link href="/orders/budget/new">
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" />
                创建预算单
              </Button>
            </Link>
          </div>
        </div>

        {/* Status Tabs */}
        <Tabs value={statusFilter} onValueChange={setStatusFilter}>
          <TabsList>
            <TabsTrigger value="all">全部 ({demoBudgetOrders.length})</TabsTrigger>
            <TabsTrigger value="draft">草稿</TabsTrigger>
            <TabsTrigger value="pending_review">待审批</TabsTrigger>
            <TabsTrigger value="approved">已通过</TabsTrigger>
            <TabsTrigger value="closed">已关闭</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Orders Table */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>订单号</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead className="text-right">总收入</TableHead>
                  <TableHead className="text-right">总成本</TableHead>
                  <TableHead className="text-right">预计利润</TableHead>
                  <TableHead className="text-right">毛利率</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>下单日期</TableHead>
                  <TableHead>交货日期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredOrders.map((order) => (
                  <TableRow key={order.id} className="cursor-pointer hover:bg-muted/50">
                    <TableCell>
                      <Link href={`/orders/${order.id}`} className="text-primary hover:underline font-medium">
                        {order.order_no}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="text-sm">{order.customer?.company}</p>
                        <p className="text-xs text-muted-foreground">{order.customer?.country}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {order.currency} {order.total_revenue.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      {order.currency} {order.total_cost.toLocaleString()}
                    </TableCell>
                    <TableCell className={`text-right font-semibold ${order.estimated_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {order.currency} {order.estimated_profit.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        order.estimated_margin < 0
                          ? 'bg-red-100 text-red-700'
                          : order.estimated_margin < 15
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-green-100 text-green-700'
                      }`}>
                        {order.estimated_margin}%
                      </span>
                    </TableCell>
                    <TableCell>
                      <BudgetStatusBadge status={order.status as BudgetOrderStatus} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {order.order_date}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {order.delivery_date || '-'}
                    </TableCell>
                  </TableRow>
                ))}
                {filteredOrders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                      没有找到匹配的订单
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
