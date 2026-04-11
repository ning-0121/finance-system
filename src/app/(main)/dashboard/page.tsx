'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DollarSign, TrendingUp, Package, AlertTriangle,
  ArrowUpRight, ArrowDownRight, Loader2, CheckCircle,
  Clock, Shield, ChevronRight, Zap,
} from 'lucide-react'
import { BudgetStatusBadge } from '@/components/shared/StatusBadge'
import Link from 'next/link'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts'
import { getBudgetOrders, getProfitSummary, getAlerts, getMonthlyProfitData, getPendingRiskEvents, getPendingDocumentActions, getTrustScoreSummary } from '@/lib/supabase/queries'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import type { BudgetOrder, Alert, ProfitSummary, BudgetOrderStatus } from '@/lib/types'

export default function DashboardPage() {
  const [orders, setOrders] = useState<BudgetOrder[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [summary, setSummary] = useState<ProfitSummary | null>(null)
  const [riskEvents, setRiskEvents] = useState<Record<string, unknown>[]>([])
  const [pendingActions, setPendingActions] = useState<Record<string, unknown>[]>([])
  const [trustSummary, setTrustSummary] = useState<{ distribution: Record<string, number>; recentDegrades: Record<string, unknown>[] }>({ distribution: {}, recentDegrades: [] })
  const [loading, setLoading] = useState(true)
  const [drillDown, setDrillDown] = useState<string | null>(null)
  const monthlyProfit = getMonthlyProfitData()

  useEffect(() => {
    async function load() {
      const [ordersData, alertsData, summaryData, risks, actions, trust] = await Promise.all([
        getBudgetOrders(), getAlerts(), getProfitSummary(),
        getPendingRiskEvents(), getPendingDocumentActions(), getTrustScoreSummary(),
      ])
      setOrders(ordersData); setAlerts(alertsData); setSummary(summaryData)
      setRiskEvents(risks); setPendingActions(actions); setTrustSummary(trust)
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const s = summary || { total_revenue: 0, total_profit: 0, order_count: 0, avg_margin: 0, total_cost: 0, period: '' }
  const unreadAlerts = alerts.filter(a => !a.is_read)

  // Explanation生成
  const topProfit = [...orders].sort((a, b) => b.estimated_profit - a.estimated_profit).slice(0, 3)
  const bottomProfit = [...orders].sort((a, b) => a.estimated_profit - b.estimated_profit).slice(0, 3)
  const lowMarginOrders = orders.filter(o => o.estimated_margin < 15)
  const lossOrders = orders.filter(o => o.estimated_profit < 0)

  const profitExplanation = lossOrders.length > 0
    ? `⚠️ ${lossOrders.length}个订单亏损，最大亏损 ${lossOrders[0]?.order_no} (${lossOrders[0]?.estimated_margin}%)`
    : lowMarginOrders.length > 0
    ? `${lowMarginOrders.length}个订单毛利率低于15%警戒线`
    : `所有订单利润率正常`

  const stats = [
    { key: 'revenue', title: '本月营收', value: `$${(s.total_revenue / 1000).toFixed(0)}K`, change: 5.2, icon: DollarSign, color: 'text-blue-600', bgColor: 'bg-blue-50' },
    { key: 'profit', title: '本月利润', value: `$${(s.total_profit / 1000).toFixed(0)}K`, change: -3.4, icon: TrendingUp, color: 'text-green-600', bgColor: 'bg-green-50' },
    { key: 'orders', title: '活跃订单', value: s.order_count.toString(), change: 12, icon: Package, color: 'text-purple-600', bgColor: 'bg-purple-50' },
    { key: 'margin', title: '平均毛利率', value: `${s.avg_margin}%`, change: -1.2, icon: AlertTriangle, color: 'text-amber-600', bgColor: 'bg-amber-50' },
  ]

  const handleMarkResolved = async (alertId: string) => {
    setAlerts(alerts.map(a => a.id === alertId ? { ...a, is_read: true } : a))
    try {
      const supabase = createClient()
      await supabase.from('alerts').update({ is_read: true }).eq('id', alertId)
      await supabase.from('financial_risk_events').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', alertId)
    } catch { /* demo */ }
    toast.success('已标记处理')
  }

  // Drill-down数据
  const getDrillDownContent = (key: string) => {
    switch (key) {
      case 'revenue': return { title: '营收分析', items: [...orders].sort((a, b) => b.total_revenue - a.total_revenue).slice(0, 5).map(o => ({ label: `${o.order_no} · ${o.customer?.company || ''}`, value: `${o.currency} ${o.total_revenue.toLocaleString()}` })) }
      case 'profit': return { title: '利润分析', items: [...topProfit, ...bottomProfit].map(o => ({ label: `${o.order_no} · ${o.customer?.company || ''}`, value: `${o.currency} ${o.estimated_profit.toLocaleString()} (${o.estimated_margin}%)` })) }
      case 'orders': return { title: '订单状态', items: [{ label: '草稿', value: orders.filter(o => o.status === 'draft').length.toString() }, { label: '待审批', value: orders.filter(o => o.status === 'pending_review').length.toString() }, { label: '已通过', value: orders.filter(o => o.status === 'approved').length.toString() }, { label: '已关闭', value: orders.filter(o => o.status === 'closed').length.toString() }] }
      case 'margin': return { title: '毛利率分析', items: [...orders].sort((a, b) => a.estimated_margin - b.estimated_margin).slice(0, 5).map(o => ({ label: `${o.order_no} · ${o.customer?.company || ''}`, value: `${o.estimated_margin}%` })) }
      default: return { title: '', items: [] }
    }
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="工作台" subtitle={`${s.period || new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })} · ${profitExplanation}`} />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">

        {/* KPI卡片（可drill-down） */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {stats.map(stat => (
            <Card key={stat.key} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setDrillDown(stat.key)}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground">{stat.title}</p>
                    <p className="text-2xl font-bold mt-1">{stat.value}</p>
                    <div className="flex items-center gap-1 mt-1">
                      {stat.change > 0 ? <ArrowUpRight className="h-3 w-3 text-green-600" /> : <ArrowDownRight className="h-3 w-3 text-red-600" />}
                      <span className={`text-xs font-medium ${stat.change > 0 ? 'text-green-600' : 'text-red-600'}`}>{Math.abs(stat.change)}%</span>
                    </div>
                  </div>
                  <div className={`p-2.5 rounded-xl ${stat.bgColor}`}><stat.icon className={`h-5 w-5 ${stat.color}`} /></div>
                </div>
                <p className="text-[10px] text-primary mt-1">点击查看详情 →</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* 待处理动作中心 + 信任快照 */}
        {(pendingActions.length > 0 || riskEvents.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 待处理动作 */}
            <Card className="border-amber-200">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4 text-amber-500" />待处理 ({pendingActions.length + riskEvents.length})</CardTitle>
                  <Link href="/risks"><Button variant="ghost" size="sm" className="text-xs">查看全部</Button></Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {riskEvents.slice(0, 3).map((r, i) => (
                  <div key={i} className="flex items-center justify-between p-2 bg-red-50/50 rounded-lg text-sm">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium truncate block">{String(r.title || '')}</span>
                      <span className="text-xs text-muted-foreground">{String(r.risk_type || '')}</span>
                    </div>
                    <Badge variant={r.risk_level === 'red' ? 'destructive' : 'secondary'} className="text-[9px] shrink-0">{r.risk_level === 'red' ? '严重' : '关注'}</Badge>
                  </div>
                ))}
                {pendingActions.slice(0, 2).map((a, i) => (
                  <div key={`a-${i}`} className="flex items-center justify-between p-2 bg-amber-50/50 rounded-lg text-sm">
                    <span className="font-medium">{String(a.action_type || '')}</span>
                    <Badge variant="outline" className="text-[9px]">待确认</Badge>
                  </div>
                ))}
                {pendingActions.length === 0 && riskEvents.length === 0 && (
                  <div className="text-center py-4 text-muted-foreground text-sm">
                    <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-300" />暂无待处理项
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 信任治理快照 */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2"><Shield className="h-4 w-4 text-blue-500" />信任治理</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-6 gap-1 mb-3">
                  {['T0', 'T1', 'T2', 'T3', 'T4', 'T5'].map(level => (
                    <div key={level} className="text-center">
                      <div className={`text-lg font-bold ${
                        level === 'T0' || level === 'T1' ? 'text-red-600' : level === 'T4' || level === 'T5' ? 'text-green-600' : ''
                      }`}>{trustSummary.distribution[level] || 0}</div>
                      <div className="text-[9px] text-muted-foreground">{level}</div>
                    </div>
                  ))}
                </div>
                {trustSummary.recentDegrades.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-muted-foreground">低信任对象</p>
                    {trustSummary.recentDegrades.slice(0, 3).map((d, i) => (
                      <div key={i} className="flex items-center justify-between text-xs p-1 bg-red-50 rounded">
                        <span>{String(d.subject_id || '')}</span>
                        <Badge variant="destructive" className="text-[8px]">{String(d.trust_level || '')}</Badge>
                      </div>
                    ))}
                  </div>
                )}
                {trustSummary.recentDegrades.length === 0 && Object.values(trustSummary.distribution).every(v => v === 0) && (
                  <p className="text-center text-xs text-muted-foreground py-2">暂无信任数据</p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* 图表行 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2"><CardTitle className="text-sm">营收与利润趋势</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={monthlyProfit}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} />
                  <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                  <Bar dataKey="revenue" name="营收" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="profit" name="利润" fill="#22c55e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">毛利率走势</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={monthlyProfit}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={[10, 25]} tickFormatter={v => `${v}%`} />
                  <Tooltip formatter={(value) => [`${value}%`, '毛利率']} />
                  <Line type="monotone" dataKey="margin" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* 订单列表 + 可操作预警 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">最近预算单</CardTitle>
                <Link href="/orders" className="text-xs text-primary hover:underline">查看全部</Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {orders.slice(0, 4).map(order => (
                <Link key={order.id} href={`/orders/${order.id}`} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{order.order_no}</span>
                      <BudgetStatusBadge status={order.status as BudgetOrderStatus} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{order.customer?.company || '-'} · {order.currency} {order.total_revenue.toLocaleString()}</p>
                  </div>
                  <p className={`text-sm font-semibold ${order.estimated_margin < 0 ? 'text-red-600' : order.estimated_margin < 15 ? 'text-amber-600' : 'text-green-600'}`}>{order.estimated_margin}%</p>
                </Link>
              ))}
            </CardContent>
          </Card>

          {/* 可操作预警中心 */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">预警中心</CardTitle>
                {unreadAlerts.length > 0 && <Badge variant="destructive" className="text-[9px]">{unreadAlerts.length}</Badge>}
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {alerts.slice(0, 4).map(alert => (
                <div key={alert.id} className={`p-2 rounded-lg border-l-4 ${
                  alert.severity === 'critical' ? 'border-l-red-500 bg-red-50' : alert.severity === 'warning' ? 'border-l-amber-500 bg-amber-50' : 'border-l-blue-500 bg-blue-50'
                } ${alert.is_read ? 'opacity-50' : ''}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{alert.title}</span>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{alert.message}</p>
                    </div>
                    {!alert.is_read && (
                      <Button variant="ghost" size="sm" className="h-6 text-[10px] shrink-0" onClick={() => handleMarkResolved(alert.id)}>
                        <CheckCircle className="h-3 w-3 mr-0.5" />已处理
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              {alerts.length === 0 && <p className="text-center text-muted-foreground py-6 text-sm">暂无预警</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Drill-Down弹窗 */}
      {drillDown && (
        <Dialog open={true} onOpenChange={() => setDrillDown(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{getDrillDownContent(drillDown).title}</DialogTitle></DialogHeader>
            <div className="space-y-2 py-2">
              {getDrillDownContent(drillDown).items.map((item, i) => (
                <div key={i} className="flex items-center justify-between p-2 bg-muted/50 rounded-lg text-sm">
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="font-semibold shrink-0 ml-2">{item.value}</span>
                </div>
              ))}
              {getDrillDownContent(drillDown).items.length === 0 && (
                <p className="text-center text-muted-foreground py-4">暂无数据</p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
