'use client'

import { useState } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DollarSign, TrendingUp, TrendingDown, AlertTriangle, Calendar } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { CASHFLOW_WARNING_COLORS, type CashflowScenario } from '@/lib/types/agent'

// 三种情景数据
const scenarios: Record<CashflowScenario, { label: string; data: { date: string; inflow: number; outflow: number; balance: number; warning: string }[] }> = {
  normal: {
    label: '正常模式',
    data: [
      { date: '04/09', inflow: 45000, outflow: 38000, balance: 320000, warning: 'safe' },
      { date: '04/10', inflow: 12000, outflow: 5000, balance: 327000, warning: 'safe' },
      { date: '04/11', inflow: 0, outflow: 32000, balance: 295000, warning: 'safe' },
      { date: '04/12', inflow: 8000, outflow: 23000, balance: 280000, warning: 'attention' },
      { date: '04/13', inflow: 60000, outflow: 5000, balance: 335000, warning: 'safe' },
      { date: '04/14', inflow: 0, outflow: 25000, balance: 310000, warning: 'safe' },
      { date: '04/15', inflow: 0, outflow: 42000, balance: 268000, warning: 'attention' },
      { date: '04/16', inflow: 30000, outflow: 15000, balance: 283000, warning: 'safe' },
      { date: '04/17', inflow: 0, outflow: 8000, balance: 275000, warning: 'safe' },
      { date: '04/18', inflow: 85000, outflow: 20000, balance: 340000, warning: 'safe' },
    ],
  },
  conservative: {
    label: '保守模式（客户延迟回款）',
    data: [
      { date: '04/09', inflow: 45000, outflow: 38000, balance: 320000, warning: 'safe' },
      { date: '04/10', inflow: 0, outflow: 5000, balance: 315000, warning: 'safe' },
      { date: '04/11', inflow: 0, outflow: 32000, balance: 283000, warning: 'attention' },
      { date: '04/12', inflow: 0, outflow: 23000, balance: 260000, warning: 'attention' },
      { date: '04/13', inflow: 20000, outflow: 5000, balance: 275000, warning: 'attention' },
      { date: '04/14', inflow: 0, outflow: 25000, balance: 250000, warning: 'danger' },
      { date: '04/15', inflow: 0, outflow: 42000, balance: 208000, warning: 'danger' },
      { date: '04/16', inflow: 0, outflow: 15000, balance: 193000, warning: 'danger' },
      { date: '04/17', inflow: 0, outflow: 8000, balance: 185000, warning: 'danger' },
      { date: '04/18', inflow: 40000, outflow: 20000, balance: 205000, warning: 'danger' },
    ],
  },
  extreme: {
    label: '极端模式（坏账+涨价+延迟）',
    data: [
      { date: '04/09', inflow: 45000, outflow: 45000, balance: 320000, warning: 'safe' },
      { date: '04/10', inflow: 0, outflow: 10000, balance: 310000, warning: 'safe' },
      { date: '04/11', inflow: 0, outflow: 40000, balance: 270000, warning: 'attention' },
      { date: '04/12', inflow: 0, outflow: 30000, balance: 240000, warning: 'danger' },
      { date: '04/13', inflow: 0, outflow: 15000, balance: 225000, warning: 'danger' },
      { date: '04/14', inflow: 0, outflow: 35000, balance: 190000, warning: 'danger' },
      { date: '04/15', inflow: 0, outflow: 50000, balance: 140000, warning: 'critical' },
      { date: '04/16', inflow: 0, outflow: 20000, balance: 120000, warning: 'critical' },
      { date: '04/17', inflow: 0, outflow: 15000, balance: 105000, warning: 'critical' },
      { date: '04/18', inflow: 20000, outflow: 25000, balance: 100000, warning: 'critical' },
    ],
  },
}

export default function CashflowPage() {
  const [scenario, setScenario] = useState<CashflowScenario>('normal')
  const data = scenarios[scenario]
  const minBalance = Math.min(...data.data.map(d => d.balance))
  const maxGap = Math.max(...data.data.map(d => d.outflow - d.inflow))
  const dangerDays = data.data.filter(d => d.warning === 'danger' || d.warning === 'critical')
  const lowestDay = data.data.reduce((min, d) => d.balance < min.balance ? d : min, data.data[0])

  return (
    <div className="flex flex-col h-full">
      <Header title="现金流预测" subtitle="AI Agent 每日自动预测 · 三种情景模拟" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50"><DollarSign className="h-4 w-4 text-blue-600" /></div>
              <div><p className="text-xs text-muted-foreground">当前余额</p><p className="text-xl font-bold">${data.data[0].balance.toLocaleString()}</p></div>
            </CardContent>
          </Card>
          <Card className={minBalance < 200000 ? 'border-red-200' : ''}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-50"><TrendingDown className="h-4 w-4 text-red-600" /></div>
              <div><p className="text-xs text-muted-foreground">最低余额</p><p className={`text-xl font-bold ${minBalance < 200000 ? 'text-red-600' : ''}`}>${minBalance.toLocaleString()}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-50"><Calendar className="h-4 w-4 text-amber-600" /></div>
              <div><p className="text-xs text-muted-foreground">最危险日期</p><p className="text-xl font-bold">{lowestDay.date}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`p-2 rounded-lg ${dangerDays.length > 0 ? 'bg-red-50' : 'bg-green-50'}`}>
                <AlertTriangle className={`h-4 w-4 ${dangerDays.length > 0 ? 'text-red-600' : 'text-green-600'}`} />
              </div>
              <div><p className="text-xs text-muted-foreground">危险天数</p><p className={`text-xl font-bold ${dangerDays.length > 0 ? 'text-red-600' : 'text-green-600'}`}>{dangerDays.length}天</p></div>
            </CardContent>
          </Card>
        </div>

        {/* 情景切换 */}
        <Tabs value={scenario} onValueChange={(v) => setScenario((v || 'normal') as CashflowScenario)}>
          <TabsList>
            <TabsTrigger value="normal">正常模式</TabsTrigger>
            <TabsTrigger value="conservative">保守模式</TabsTrigger>
            <TabsTrigger value="extreme">极端模式</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 余额趋势 */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">现金余额趋势 — {data.label}</CardTitle>
              {dangerDays.length > 0 && <Badge variant="destructive">⚠ {dangerDays.length}天资金紧张</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={data.data}>
                <defs>
                  <linearGradient id="balanceGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                <ReferenceLine y={200000} stroke="#ef4444" strokeDasharray="5 5" label="安全线 $200K" />
                <Area type="monotone" dataKey="balance" stroke="#3b82f6" fill="url(#balanceGrad)" strokeWidth={2} name="现金余额" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* 收支对比 */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">每日收支</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.data}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, '']} />
                <Legend />
                <Bar dataKey="inflow" name="收入" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="outflow" name="支出" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Agent建议 */}
        {dangerDays.length > 0 && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" />Agent 建议</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>• 催回 MegaCorp Int. 欠款 $45,000（逾期69天）</p>
              <p>• 延迟非紧急供应商付款（S3/S4级别 共 $24,000）</p>
              <p>• 与佛山永兴制衣厂谈判分期付款（$140,000）</p>
              {scenario === 'extreme' && <p>• <span className="text-red-600 font-medium">极端情景下建议准备信用额度/短期融资</span></p>}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
