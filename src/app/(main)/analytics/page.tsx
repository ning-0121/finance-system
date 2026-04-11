'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DollarSign, TrendingUp, TrendingDown, Package, Users, AlertTriangle,
  ArrowUpRight, ArrowDownRight, Loader2,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, AreaChart, Area, Legend,
} from 'recharts'
import { getBudgetOrders, getProfitSummary, getAlerts } from '@/lib/supabase/queries'
import type { BudgetOrder, Alert, ProfitSummary } from '@/lib/types'

export default function AnalyticsPage() {
  const [orders, setOrders] = useState<BudgetOrder[]>([])
  const [summary, setSummary] = useState<ProfitSummary | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [o, s, a] = await Promise.all([getBudgetOrders(), getProfitSummary(), getAlerts()])
      setOrders(o); setSummary(s); setAlerts(a); setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const s = summary || { total_revenue: 0, total_profit: 0, total_cost: 0, avg_margin: 0, order_count: 0, period: '' }

  // 从真实订单数据计算客户利润排名
  const customerMap = new Map<string, { revenue: number; profit: number; count: number }>()
  orders.forEach(o => {
    const name = o.customer?.company || '未知'
    const existing = customerMap.get(name) || { revenue: 0, profit: 0, count: 0 }
    existing.revenue += o.total_revenue; existing.profit += o.estimated_profit; existing.count++
    customerMap.set(name, existing)
  })
  const customerProfitData = Array.from(customerMap.entries())
    .map(([name, d]) => ({ name, revenue: d.revenue, profit: d.profit, margin: d.revenue > 0 ? Math.round(d.profit / d.revenue * 100) : 0 }))
    .sort((a, b) => b.revenue - a.revenue).slice(0, 8)

  // 从真实订单计算成本构成
  const totalCost = orders.reduce((s, o) => s + o.total_cost, 0)
  const totalPurchase = orders.reduce((s, o) => s + o.target_purchase_price, 0)
  const totalFreight = orders.reduce((s, o) => s + o.estimated_freight, 0)
  const totalCommission = orders.reduce((s, o) => s + o.estimated_commission, 0)
  const totalCustoms = orders.reduce((s, o) => s + o.estimated_customs_fee, 0)
  const totalOther = orders.reduce((s, o) => s + o.other_costs, 0)
  const costBreakdown = [
    { name: '采购成本', value: totalCost > 0 ? Math.round(totalPurchase / totalCost * 100) : 0, color: '#3b82f6' },
    { name: '运费', value: totalCost > 0 ? Math.round(totalFreight / totalCost * 100) : 0, color: '#22c55e' },
    { name: '佣金', value: totalCost > 0 ? Math.round(totalCommission / totalCost * 100) : 0, color: '#f59e0b' },
    { name: '报关费', value: totalCost > 0 ? Math.round(totalCustoms / totalCost * 100) : 0, color: '#ef4444' },
    { name: '其他', value: totalCost > 0 ? Math.round(totalOther / totalCost * 100) : 0, color: '#8b5cf6' },
  ].filter(c => c.value > 0)

  // 月度数据从订单按月聚合
  const monthMap = new Map<string, { revenue: number; profit: number; cost: number; count: number }>()
  orders.forEach(o => {
    const month = o.order_date?.substring(0, 7) || '未知'
    const existing = monthMap.get(month) || { revenue: 0, profit: 0, cost: 0, count: 0 }
    existing.revenue += o.total_revenue; existing.profit += o.estimated_profit; existing.cost += o.total_cost; existing.count++
    monthMap.set(month, existing)
  })
  const monthlyData = Array.from(monthMap.entries())
    .map(([month, d]) => ({ month, revenue: d.revenue, profit: d.profit, margin: d.revenue > 0 ? Math.round(d.profit / d.revenue * 1000) / 10 : 0 }))
    .sort((a, b) => a.month.localeCompare(b.month))

  return (
    <div className="flex flex-col h-full">
      <Header title="财务驾驶舱" subtitle="实时数据 · 预警中心 · 管理报表" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {[
            { label: '总营收', value: `$${(s.total_revenue / 1000).toFixed(0)}K`, icon: DollarSign, color: 'text-blue-600 bg-blue-50' },
            { label: '总利润', value: `$${(s.total_profit / 1000).toFixed(0)}K`, icon: TrendingUp, color: 'text-green-600 bg-green-50' },
            { label: '平均毛利率', value: `${s.avg_margin}%`, icon: TrendingDown, color: 'text-amber-600 bg-amber-50' },
            { label: '订单数', value: `${s.order_count}`, icon: Package, color: 'text-purple-600 bg-purple-50' },
            { label: '客户数', value: `${customerMap.size}`, icon: Users, color: 'text-indigo-600 bg-indigo-50' },
          ].map(kpi => (
            <Card key={kpi.label}><CardContent className="p-4"><div className="flex items-center gap-3"><div className={`p-2 rounded-lg ${kpi.color}`}><kpi.icon className="h-4 w-4" /></div><div><p className="text-xs text-muted-foreground">{kpi.label}</p><p className="text-xl font-bold">{kpi.value}</p></div></div></CardContent></Card>
          ))}
        </div>

        <Tabs defaultValue="overview">
          <TabsList><TabsTrigger value="overview">概览</TabsTrigger><TabsTrigger value="profit">利润分析</TabsTrigger><TabsTrigger value="alerts">预警中心</TabsTrigger></TabsList>

          <TabsContent value="overview" className="space-y-6 mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2"><CardTitle className="text-base">营收利润趋势</CardTitle></CardHeader>
                <CardContent>
                  {monthlyData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={monthlyData}>
                        <defs>
                          <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} /><stop offset="95%" stopColor="#3b82f6" stopOpacity={0} /></linearGradient>
                          <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22c55e" stopOpacity={0.15} /><stop offset="95%" stopColor="#22c55e" stopOpacity={0} /></linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                        <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 12 }} />
                        <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                        <Legend />
                        <Area type="monotone" dataKey="revenue" name="营收" stroke="#3b82f6" fillOpacity={1} fill="url(#colorRevenue)" />
                        <Area type="monotone" dataKey="profit" name="利润" stroke="#22c55e" fillOpacity={1} fill="url(#colorProfit)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : <p className="text-center text-muted-foreground py-16">暂无月度数据</p>}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">成本构成</CardTitle></CardHeader>
                <CardContent>
                  {costBreakdown.length > 0 ? (
                    <>
                      <ResponsiveContainer width="100%" height={200}>
                        <PieChart><Pie data={costBreakdown} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={4} dataKey="value">
                          {costBreakdown.map((entry, index) => <Cell key={index} fill={entry.color} />)}
                        </Pie><Tooltip formatter={(value) => [`${value}%`, '']} /></PieChart>
                      </ResponsiveContainer>
                      <div className="space-y-2 mt-2">{costBreakdown.map(item => (
                        <div key={item.name} className="flex items-center justify-between text-sm"><div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} /><span>{item.name}</span></div><span className="font-medium">{item.value}%</span></div>
                      ))}</div>
                    </>
                  ) : <p className="text-center text-muted-foreground py-16">暂无成本数据</p>}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">客户利润排名</CardTitle></CardHeader>
              <CardContent>
                {customerProfitData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={customerProfitData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
                      <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                      <Legend />
                      <Bar dataKey="revenue" name="营收" fill="#93c5fd" radius={[0, 4, 4, 0]} />
                      <Bar dataKey="profit" name="利润" fill="#86efac" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : <p className="text-center text-muted-foreground py-16">暂无客户数据</p>}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="profit" className="space-y-6 mt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">毛利率走势</CardTitle></CardHeader>
              <CardContent>
                {monthlyData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={monthlyData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} domain={[0, 40]} tickFormatter={v => `${v}%`} />
                      <Tooltip formatter={(value) => [`${value}%`, '毛利率']} />
                      <Line type="monotone" dataKey="margin" stroke="#f59e0b" strokeWidth={2} dot={{ r: 5, fill: '#f59e0b' }} name="毛利率" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : <p className="text-center text-muted-foreground py-16">暂无数据</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">订单利润对比</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {orders.slice(0, 10).map(order => (
                  <div key={order.id} className="flex items-center gap-4 p-3 rounded-lg bg-muted/50">
                    <div className="flex-1 min-w-0"><p className="text-sm font-medium">{order.order_no}</p><p className="text-xs text-muted-foreground">{order.customer?.company}</p></div>
                    <div className="text-right"><p className={`text-sm font-semibold ${order.estimated_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>${order.estimated_profit.toLocaleString()} ({order.estimated_margin}%)</p></div>
                  </div>
                ))}
                {orders.length === 0 && <p className="text-center text-muted-foreground py-8">暂无订单</p>}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="alerts" className="space-y-4 mt-4">
            {alerts.length === 0 ? <p className="text-center text-muted-foreground py-16">暂无预警</p> : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {alerts.map(alert => (
                  <Card key={alert.id} className={`border-l-4 ${alert.severity === 'critical' ? 'border-l-red-500' : alert.severity === 'warning' ? 'border-l-amber-500' : 'border-l-blue-500'}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className={`p-2 rounded-lg ${alert.severity === 'critical' ? 'bg-red-50' : alert.severity === 'warning' ? 'bg-amber-50' : 'bg-blue-50'}`}>
                          <AlertTriangle className={`h-4 w-4 ${alert.severity === 'critical' ? 'text-red-600' : alert.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'}`} />
                        </div>
                        <div className="flex-1"><h4 className="text-sm font-semibold">{alert.title}</h4><p className="text-sm text-muted-foreground mt-1">{alert.message}</p></div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
