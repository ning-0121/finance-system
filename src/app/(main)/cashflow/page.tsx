'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DollarSign, TrendingDown, AlertTriangle, Calendar, Loader2 } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import { createClient } from '@/lib/supabase/client'
import type { CashflowScenario } from '@/lib/types/agent'

export default function CashflowPage() {
  const [scenario, setScenario] = useState<CashflowScenario>('normal')
  const [loading, setLoading] = useState(true)
  const [cashData, setCashData] = useState<{ date: string; inflow: number; outflow: number; balance: number }[]>([])
  const [currentCash, setCurrentCash] = useState<number | null>(null)  // 真实银行余额合计（无预测数据时展示）

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        // 尝试从cashflow_forecasts读取
        const { data: forecasts } = await supabase
          .from('cashflow_forecasts')
          .select('forecast_date, expected_inflow, expected_outflow, expected_cash_balance, warning_level')
          .eq('scenario', scenario)
          .order('forecast_date')
          .limit(14)

        if (forecasts?.length) {
          setCashData(forecasts.map(f => ({
            date: (f.forecast_date as string).substring(5),
            inflow: f.expected_inflow as number,
            outflow: f.expected_outflow as number,
            balance: f.expected_cash_balance as number,
          })))
        } else {
          // 无预测数据：不臆造曲线。取真实银行余额展示，曲线留空，引导用 GL 现金流量表
          const { data: accts } = await supabase.from('bank_accounts').select('current_balance').eq('is_active', true)
          setCurrentCash((accts || []).reduce((s, a) => s + (Number(a.current_balance) || 0), 0))
          setCashData([])
        }
      } catch {
        setCashData([])
      }
      setLoading(false)
    }
    load()
  }, [scenario])

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const minBalance = cashData.length > 0 ? Math.min(...cashData.map(d => d.balance)) : 0
  const dangerDays = cashData.filter(d => d.balance < 200000)
  const lowestDay = cashData.length > 0 ? cashData.reduce((min, d) => d.balance < min.balance ? d : min, cashData[0]) : null
  const currentBalance = cashData.length > 0 ? cashData[0].balance : 0

  const scenarioLabels: Record<CashflowScenario, string> = { normal: '正常模式', conservative: '保守模式（回款延迟）', extreme: '极端模式（坏账+涨价）' }

  return (
    <div className="flex flex-col h-full">
      <Header title="现金流预测" subtitle="预测来自 cashflow_forecasts；无预测时展示真实银行余额（不臆造）" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {cashData.length === 0 && (
          <Card className="border-l-4 border-l-amber-400 bg-amber-50/40"><CardContent className="p-3 text-sm">
            暂无现金流预测数据。当前真实现金余额（银行账户合计）：<b>¥{(currentCash ?? 0).toLocaleString()}</b>。
            需要按期间看真实现金流入流出，请用 <a href="/gl/cash-flow" className="text-primary underline">GL → 现金流量表</a>（基于银行对账流水）。
          </CardContent></Card>
        )}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-blue-50"><DollarSign className="h-4 w-4 text-blue-600" /></div><div><p className="text-xs text-muted-foreground">{cashData.length > 0 ? '当前余额(预测)' : '当前现金余额'}</p><p className="text-xl font-bold">¥{(cashData.length > 0 ? currentBalance : (currentCash ?? 0)).toLocaleString()}</p></div></CardContent></Card>
          <Card className={minBalance < 200000 ? 'border-red-200' : ''}><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-red-50"><TrendingDown className="h-4 w-4 text-red-600" /></div><div><p className="text-xs text-muted-foreground">最低余额</p><p className={`text-xl font-bold ${minBalance < 200000 ? 'text-red-600' : ''}`}>${minBalance.toLocaleString()}</p></div></CardContent></Card>
          <Card><CardContent className="p-4 flex items-center gap-3"><div className="p-2 rounded-lg bg-amber-50"><Calendar className="h-4 w-4 text-amber-600" /></div><div><p className="text-xs text-muted-foreground">最危险日期</p><p className="text-xl font-bold">{lowestDay?.date || '-'}</p></div></CardContent></Card>
          <Card><CardContent className="p-4 flex items-center gap-3"><div className={`p-2 rounded-lg ${dangerDays.length > 0 ? 'bg-red-50' : 'bg-green-50'}`}><AlertTriangle className={`h-4 w-4 ${dangerDays.length > 0 ? 'text-red-600' : 'text-green-600'}`} /></div><div><p className="text-xs text-muted-foreground">危险天数</p><p className={`text-xl font-bold ${dangerDays.length > 0 ? 'text-red-600' : 'text-green-600'}`}>{dangerDays.length}天</p></div></CardContent></Card>
        </div>

        <Tabs value={scenario} onValueChange={v => setScenario((v || 'normal') as CashflowScenario)}>
          <TabsList><TabsTrigger value="normal">正常模式</TabsTrigger><TabsTrigger value="conservative">保守模式</TabsTrigger><TabsTrigger value="extreme">极端模式</TabsTrigger></TabsList>
        </Tabs>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">现金余额趋势 — {scenarioLabels[scenario]}</CardTitle>
              {dangerDays.length > 0 && <Badge variant="destructive">⚠ {dangerDays.length}天资金紧张</Badge>}
            </div>
          </CardHeader>
          <CardContent>
            {cashData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={cashData}>
                  <defs><linearGradient id="balanceGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} /><stop offset="95%" stopColor="#3b82f6" stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={value => [`$${Number(value).toLocaleString()}`, '']} />
                  <ReferenceLine y={200000} stroke="#ef4444" strokeDasharray="5 5" label="安全线 $200K" />
                  <Area type="monotone" dataKey="balance" stroke="#3b82f6" fill="url(#balanceGrad)" strokeWidth={2} name="现金余额" />
                </AreaChart>
              </ResponsiveContainer>
            ) : <p className="text-center text-muted-foreground py-16">暂无数据</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">每日收支</CardTitle></CardHeader>
          <CardContent>
            {cashData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={cashData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={value => [`$${Number(value).toLocaleString()}`, '']} />
                  <Legend />
                  <Bar dataKey="inflow" name="收入" fill="#22c55e" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="outflow" name="支出" fill="#ef4444" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <p className="text-center text-muted-foreground py-16">暂无数据</p>}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
