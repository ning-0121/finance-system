'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  DollarSign,
  TrendingUp,
  Package,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react'
import { demoBudgetOrders, demoAlerts, demoProfitSummary, demoMonthlyProfit } from '@/lib/demo-data'
import { BudgetStatusBadge } from '@/components/shared/StatusBadge'
import Link from 'next/link'
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
} from 'recharts'

const stats = [
  {
    title: '本月营收',
    value: `$${(demoProfitSummary.total_revenue / 1000).toFixed(0)}K`,
    change: 5.2,
    icon: DollarSign,
    color: 'text-blue-600',
    bgColor: 'bg-blue-50',
  },
  {
    title: '本月利润',
    value: `$${(demoProfitSummary.total_profit / 1000).toFixed(0)}K`,
    change: -3.4,
    icon: TrendingUp,
    color: 'text-green-600',
    bgColor: 'bg-green-50',
  },
  {
    title: '活跃订单',
    value: demoProfitSummary.order_count.toString(),
    change: 12,
    icon: Package,
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
  },
  {
    title: '平均毛利率',
    value: `${demoProfitSummary.avg_margin}%`,
    change: -1.2,
    icon: AlertTriangle,
    color: 'text-amber-600',
    bgColor: 'bg-amber-50',
  },
]

const formatCurrency = (value: number) => `$${(value / 1000).toFixed(0)}K`

export default function DashboardPage() {
  return (
    <div className="flex flex-col h-full">
      <Header title="工作台" subtitle={`欢迎回来，${demoProfitSummary.period}`} />
      <div className="flex-1 p-6 space-y-6 overflow-y-auto">
        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map((stat) => (
            <Card key={stat.title}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">{stat.title}</p>
                    <p className="text-2xl font-bold mt-1">{stat.value}</p>
                    <div className="flex items-center gap-1 mt-1">
                      {stat.change > 0 ? (
                        <ArrowUpRight className="h-3 w-3 text-green-600" />
                      ) : (
                        <ArrowDownRight className="h-3 w-3 text-red-600" />
                      )}
                      <span className={`text-xs font-medium ${stat.change > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {Math.abs(stat.change)}%
                      </span>
                      <span className="text-xs text-muted-foreground">vs上月</span>
                    </div>
                  </div>
                  <div className={`p-3 rounded-xl ${stat.bgColor}`}>
                    <stat.icon className={`h-5 w-5 ${stat.color}`} />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Revenue & Profit Chart */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">营收与利润趋势</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={demoMonthlyProfit}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={formatCurrency} />
                  <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                  <Bar dataKey="revenue" name="营收" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="profit" name="利润" fill="#22c55e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Margin Trend */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">毛利率走势</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={demoMonthlyProfit}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} domain={[10, 25]} tickFormatter={(v) => `${v}%`} />
                  <Tooltip formatter={(value) => [`${value}%`, '毛利率']} />
                  <Line type="monotone" dataKey="margin" stroke="#f59e0b" strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent Orders */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">最近预算单</CardTitle>
                <Link href="/orders" className="text-sm text-primary hover:underline">查看全部</Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {demoBudgetOrders.slice(0, 4).map((order) => (
                <Link
                  key={order.id}
                  href={`/orders/${order.id}`}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-muted transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{order.order_no}</span>
                      <BudgetStatusBadge status={order.status} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {order.customer?.company} · {order.currency} {order.total_revenue.toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${order.estimated_margin < 0 ? 'text-red-600' : order.estimated_margin < 15 ? 'text-amber-600' : 'text-green-600'}`}>
                      {order.estimated_margin}%
                    </p>
                    <p className="text-[10px] text-muted-foreground">预计毛利率</p>
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>

          {/* Alerts */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">预警中心</CardTitle>
                <Badge variant="destructive" className="text-[10px]">
                  {demoAlerts.filter(a => !a.is_read).length} 条未读
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {demoAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3 rounded-lg border-l-4 ${
                    alert.severity === 'critical'
                      ? 'border-l-red-500 bg-red-50'
                      : alert.severity === 'warning'
                      ? 'border-l-amber-500 bg-amber-50'
                      : 'border-l-blue-500 bg-blue-50'
                  } ${alert.is_read ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className={`h-3.5 w-3.5 ${
                      alert.severity === 'critical' ? 'text-red-600' : alert.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'
                    }`} />
                    <span className="text-sm font-medium">{alert.title}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{alert.message}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
