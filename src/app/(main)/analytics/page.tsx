'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  demoProfitSummary,
  demoMonthlyProfit,
  demoBudgetOrders,
  demoSettlementOrders,
  demoAlerts,
  demoCustomers,
} from '@/lib/demo-data'
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Package,
  Users,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Area,
  AreaChart,
  Legend,
} from 'recharts'

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6']

const customerProfitData = [
  { name: 'Global Trading', revenue: 72000, profit: 11680, margin: 16.22 },
  { name: 'Euro Imports', revenue: 60000, profit: 6700, margin: 11.17 },
  { name: 'Tokyo Solutions', revenue: 90000, profit: 21800, margin: 24.22 },
]

const costBreakdown = [
  { name: '采购成本', value: 65, color: '#3b82f6' },
  { name: '运费', value: 14, color: '#22c55e' },
  { name: '佣金', value: 12, color: '#f59e0b' },
  { name: '报关费', value: 5, color: '#ef4444' },
  { name: '其他', value: 4, color: '#8b5cf6' },
]

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col h-full">
      <Header title="财务驾驶舱" subtitle="实时汇总 · 预警中心 · 管理报表" />

      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {/* KPI Row */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {[
            { label: '本月营收', value: `$${(demoProfitSummary.total_revenue / 1000).toFixed(0)}K`, change: 5.2, icon: DollarSign, color: 'text-blue-600 bg-blue-50' },
            { label: '本月利润', value: `$${(demoProfitSummary.total_profit / 1000).toFixed(0)}K`, change: -3.4, icon: TrendingUp, color: 'text-green-600 bg-green-50' },
            { label: '平均毛利率', value: `${demoProfitSummary.avg_margin}%`, change: -1.2, icon: TrendingDown, color: 'text-amber-600 bg-amber-50' },
            { label: '活跃订单', value: `${demoProfitSummary.order_count}`, change: 12, icon: Package, color: 'text-purple-600 bg-purple-50' },
            { label: '活跃客户', value: `${demoCustomers.length}`, change: 0, icon: Users, color: 'text-indigo-600 bg-indigo-50' },
          ].map((kpi) => (
            <Card key={kpi.label}>
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${kpi.color}`}>
                    <kpi.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{kpi.label}</p>
                    <p className="text-xl font-bold">{kpi.value}</p>
                    {kpi.change !== 0 && (
                      <div className="flex items-center gap-0.5">
                        {kpi.change > 0 ? <ArrowUpRight className="h-3 w-3 text-green-600" /> : <ArrowDownRight className="h-3 w-3 text-red-600" />}
                        <span className={`text-[10px] ${kpi.change > 0 ? 'text-green-600' : 'text-red-600'}`}>{Math.abs(kpi.change)}%</span>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="profit">利润分析</TabsTrigger>
            <TabsTrigger value="alerts">预警中心</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6 mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Revenue Trend */}
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">营收利润趋势（6个月）</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={demoMonthlyProfit}>
                      <defs>
                        <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#22c55e" stopOpacity={0.15} />
                          <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} />
                      <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                      <Legend />
                      <Area type="monotone" dataKey="revenue" name="营收" stroke="#3b82f6" fillOpacity={1} fill="url(#colorRevenue)" />
                      <Area type="monotone" dataKey="profit" name="利润" stroke="#22c55e" fillOpacity={1} fill="url(#colorProfit)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Cost Breakdown */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">成本构成</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={costBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={4}
                        dataKey="value"
                      >
                        {costBreakdown.map((entry, index) => (
                          <Cell key={index} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => [`${value}%`, '']} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-2 mt-2">
                    {costBreakdown.map((item) => (
                      <div key={item.name} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                          <span>{item.name}</span>
                        </div>
                        <span className="font-medium">{item.value}%</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Customer Profit */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">客户利润排名</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={customerProfitData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} />
                    <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                    <Legend />
                    <Bar dataKey="revenue" name="营收" fill="#93c5fd" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="profit" name="利润" fill="#86efac" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="profit" className="space-y-6 mt-4">
            {/* Margin Trend */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">毛利率走势</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={demoMonthlyProfit}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} domain={[10, 25]} tickFormatter={(v) => `${v}%`} />
                    <Tooltip formatter={(value) => [`${value}%`, '毛利率']} />
                    <Line type="monotone" dataKey="margin" stroke="#f59e0b" strokeWidth={2} dot={{ r: 5, fill: '#f59e0b' }} />
                    {/* Warning line at 15% */}
                    <Line type="monotone" dataKey={() => 15} stroke="#ef4444" strokeDasharray="5 5" strokeWidth={1} dot={false} name="警戒线" />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Per-order profit */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">订单利润对比</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {demoBudgetOrders.map((order) => {
                    const settlement = demoSettlementOrders.find(s => s.budget_order_id === order.id)
                    return (
                      <div key={order.id} className="flex items-center gap-4 p-3 rounded-lg bg-muted/50">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{order.order_no}</p>
                          <p className="text-xs text-muted-foreground">{order.customer?.company}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-muted-foreground">预算利润</p>
                          <p className={`text-sm font-semibold ${order.estimated_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                            ${order.estimated_profit.toLocaleString()} ({order.estimated_margin}%)
                          </p>
                        </div>
                        {settlement && (
                          <div className="text-right">
                            <p className="text-xs text-muted-foreground">实际利润</p>
                            <p className={`text-sm font-semibold ${settlement.actual_profit < 0 ? 'text-red-600' : 'text-green-600'}`}>
                              ${settlement.actual_profit.toLocaleString()} ({settlement.actual_margin}%)
                            </p>
                          </div>
                        )}
                        <div className="w-16 text-right">
                          {settlement ? (
                            <Badge variant={settlement.variance_percentage < -5 ? 'destructive' : 'secondary'}>
                              {settlement.variance_percentage > 0 ? '+' : ''}{settlement.variance_percentage}%
                            </Badge>
                          ) : (
                            <Badge variant="outline">待结算</Badge>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="alerts" className="space-y-4 mt-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {demoAlerts.map((alert) => (
                <Card key={alert.id} className={`border-l-4 ${
                  alert.severity === 'critical' ? 'border-l-red-500' :
                  alert.severity === 'warning' ? 'border-l-amber-500' : 'border-l-blue-500'
                }`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${
                        alert.severity === 'critical' ? 'bg-red-50' :
                        alert.severity === 'warning' ? 'bg-amber-50' : 'bg-blue-50'
                      }`}>
                        <AlertTriangle className={`h-4 w-4 ${
                          alert.severity === 'critical' ? 'text-red-600' :
                          alert.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'
                        }`} />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="text-sm font-semibold">{alert.title}</h4>
                          <Badge variant={alert.severity === 'critical' ? 'destructive' : alert.severity === 'warning' ? 'secondary' : 'outline'} className="text-[10px]">
                            {alert.severity === 'critical' ? '严重' : alert.severity === 'warning' ? '警告' : '提示'}
                          </Badge>
                          {!alert.is_read && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                        </div>
                        <p className="text-sm text-muted-foreground">{alert.message}</p>
                        <p className="text-xs text-muted-foreground mt-2">
                          {new Date(alert.created_at).toLocaleString('zh-CN')}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
