'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DollarSign, TrendingDown, TrendingUp, AlertTriangle, Users, Factory,
  ArrowUpRight, ArrowDownRight, Shield, Zap, Clock,
} from 'lucide-react'
import Link from 'next/link'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

// 演示数据 — 生产环境由Agent自动生成
const cashflowData = [
  { date: '04/09', balance: 320000, inflow: 45000, outflow: 38000 },
  { date: '04/10', balance: 327000, inflow: 12000, outflow: 5000 },
  { date: '04/11', balance: 295000, inflow: 0, outflow: 32000 },
  { date: '04/12', balance: 280000, inflow: 8000, outflow: 23000 },
  { date: '04/13', balance: 335000, inflow: 60000, outflow: 5000 },
  { date: '04/14', balance: 310000, inflow: 0, outflow: 25000 },
  { date: '04/15', balance: 268000, inflow: 0, outflow: 42000 },
]

const riskCustomers = [
  { name: 'ABC Trading', risk: 'D', outstanding: 42000, overdueDays: 25, action: '已催款2次' },
  { name: 'MegaCorp Int.', risk: 'C', outstanding: 45000, overdueDays: 69, action: '建议暂停出货' },
]

const riskOrders = [
  { orderNo: 'BO-202604-0002', customer: 'Euro Imports', margin: 11.17, issue: '毛利率低于15%' },
  { orderNo: 'BO-202603-0005', customer: 'Global Trading', margin: -5.22, issue: '实际亏损' },
]

const urgentPayments = [
  { supplier: '深圳华锦纺织', amount: 36000, due: '2天后', priority: 'S1' },
  { supplier: '佛山永兴制衣厂', amount: 140000, due: '5天后', priority: 'S2' },
]

export default function BossDashboardPage() {
  const cashBalance = 320000
  const weekInflow = 125000
  const weekOutflow = 170000
  const dangerDate = '4月15日'

  return (
    <div className="flex flex-col h-full">
      <Header title="老板驾驶舱" subtitle="AI Agent 实时分析 · 风险预警 · 决策建议" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* 顶部6卡片 */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {/* 现金流 */}
          <Card className="border-l-4 border-l-blue-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="p-2 rounded-lg bg-blue-50"><DollarSign className="h-4 w-4 text-blue-600" /></div>
                <Badge variant="outline" className="text-[10px]">实时</Badge>
              </div>
              <p className="text-xs text-muted-foreground">当前现金余额</p>
              <p className="text-2xl font-bold">${cashBalance.toLocaleString()}</p>
              <div className="flex items-center gap-3 mt-2 text-xs">
                <span className="text-green-600 flex items-center"><ArrowUpRight className="h-3 w-3" />本周入 ${weekInflow.toLocaleString()}</span>
                <span className="text-red-600 flex items-center"><ArrowDownRight className="h-3 w-3" />本周出 ${weekOutflow.toLocaleString()}</span>
              </div>
            </CardContent>
          </Card>

          {/* 回款风险 */}
          <Card className="border-l-4 border-l-red-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="p-2 rounded-lg bg-red-50"><AlertTriangle className="h-4 w-4 text-red-600" /></div>
                <Badge variant="destructive" className="text-[10px]">2项</Badge>
              </div>
              <p className="text-xs text-muted-foreground">逾期应收</p>
              <p className="text-2xl font-bold text-red-600">${(42000 + 45000).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground mt-2">2个客户逾期，最长69天</p>
            </CardContent>
          </Card>

          {/* 付款压力 */}
          <Card className="border-l-4 border-l-amber-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="p-2 rounded-lg bg-amber-50"><Clock className="h-4 w-4 text-amber-600" /></div>
                <Badge variant="secondary" className="text-[10px]">本周</Badge>
              </div>
              <p className="text-xs text-muted-foreground">本周必须付款</p>
              <p className="text-2xl font-bold text-amber-600">${(36000 + 140000).toLocaleString()}</p>
              <p className="text-xs text-muted-foreground mt-2">2笔，影响生产进度</p>
            </CardContent>
          </Card>

          {/* 高风险客户 */}
          <Card className="border-l-4 border-l-orange-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="p-2 rounded-lg bg-orange-50"><Users className="h-4 w-4 text-orange-600" /></div>
              </div>
              <p className="text-xs text-muted-foreground">高风险客户</p>
              <p className="text-2xl font-bold">{riskCustomers.length}</p>
              <p className="text-xs text-muted-foreground mt-2">{riskCustomers.map(c => c.name).join('、')}</p>
            </CardContent>
          </Card>

          {/* 异常利润 */}
          <Card className="border-l-4 border-l-purple-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="p-2 rounded-lg bg-purple-50"><TrendingDown className="h-4 w-4 text-purple-600" /></div>
              </div>
              <p className="text-xs text-muted-foreground">利润异常订单</p>
              <p className="text-2xl font-bold">{riskOrders.length}</p>
              <p className="text-xs text-muted-foreground mt-2">1笔亏损，1笔低利润</p>
            </CardContent>
          </Card>

          {/* Agent状态 */}
          <Card className="border-l-4 border-l-green-500">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="p-2 rounded-lg bg-green-50"><Zap className="h-4 w-4 text-green-600" /></div>
                <Badge className="bg-green-100 text-green-700 text-[10px]">运行中</Badge>
              </div>
              <p className="text-xs text-muted-foreground">AI Agent</p>
              <p className="text-2xl font-bold">8</p>
              <p className="text-xs text-muted-foreground mt-2">个Agent持续监控中</p>
            </CardContent>
          </Card>
        </div>

        {/* 现金流趋势 */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">7天现金流预测</CardTitle>
              <Badge variant="destructive" className="text-[10px]">⚠ {dangerDate}资金紧张</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={cashflowData}>
                <defs>
                  <linearGradient id="cashGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                <Area type="monotone" dataKey="balance" stroke="#3b82f6" fill="url(#cashGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 高风险客户 */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4 text-red-500" />高风险客户</CardTitle>
                <Link href="/receivables"><Button variant="ghost" size="sm">查看全部</Button></Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {riskCustomers.map((c, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-red-50/50 rounded-lg">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{c.name}</span>
                      <Badge variant="destructive" className="text-[10px]">等级{c.risk}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">逾期{c.overdueDays}天 · {c.action}</p>
                  </div>
                  <p className="font-semibold text-red-600">${c.outstanding.toLocaleString()}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 需立即处理 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4 text-amber-500" />建议立即处理</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {urgentPayments.map((p, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-amber-50/50 rounded-lg">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px]">{p.priority}</Badge>
                      <span className="text-sm font-medium">{p.supplier}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{p.due}到期 · 影响生产</p>
                  </div>
                  <p className="font-semibold">¥{p.amount.toLocaleString()}</p>
                </div>
              ))}
              {riskOrders.map((o, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-purple-50/50 rounded-lg">
                  <div>
                    <span className="text-sm font-medium">{o.orderNo}</span>
                    <p className="text-xs text-muted-foreground mt-1">{o.customer} · {o.issue}</p>
                  </div>
                  <p className={`font-semibold ${o.margin < 0 ? 'text-red-600' : 'text-amber-600'}`}>{o.margin}%</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
