'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Loader2, TrendingUp, TrendingDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type PLLine = {
  account_code: string
  account_name: string
  account_type: string
  period_debit: number
  period_credit: number
}

export default function ProfitLossPage() {
  const [period, setPeriod] = useState('')
  const [periods, setPeriods] = useState<string[]>([])
  const [data, setData] = useState<PLLine[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data: p } = await supabase.from('accounting_periods').select('period_code').order('period_code', { ascending: false })
      if (p?.length) {
        const codes = p.map(x => x.period_code as string)
        setPeriods(codes)
        const current = new Date().toISOString().substring(0, 7)
        setPeriod(codes.find(c => c === current) || codes[0])
      }
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (!period) return
    async function loadPL() {
      setLoading(true)
      const supabase = createClient()
      const { data: balances } = await supabase
        .from('gl_balances')
        .select('account_code, period_debit, period_credit, accounts(account_name, account_type)')
        .eq('period_code', period)
        .order('account_code')

      if (balances) {
        setData(balances.map(b => ({
          account_code: b.account_code,
          account_name: (b.accounts as unknown as Record<string, string>)?.account_name || '',
          account_type: (b.accounts as unknown as Record<string, string>)?.account_type || '',
          period_debit: b.period_debit as number,
          period_credit: b.period_credit as number,
        })).filter(b => b.account_type === 'revenue' || b.account_type === 'expense'))
      }
      setLoading(false)
    }
    loadPL()
  }, [period])

  const revenueItems = data.filter(d => d.account_type === 'revenue')
  const expenseItems = data.filter(d => d.account_type === 'expense')
  const totalRevenue = revenueItems.reduce((s, d) => s + d.period_credit - d.period_debit, 0)
  const totalExpense = expenseItems.reduce((s, d) => s + d.period_debit - d.period_credit, 0)
  const netProfit = totalRevenue - totalExpense
  const margin = totalRevenue > 0 ? (netProfit / totalRevenue * 100).toFixed(1) : '0'

  if (loading && !period) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="利润表" subtitle="收入 - 成本 - 费用 = 净利润 · 基于总账数据" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center gap-4">
          <Select value={period} onValueChange={v => setPeriod(v || '')}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="选择期间" /></SelectTrigger>
            <SelectContent>
              {periods.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* KPI */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">营业收入</p><p className="text-xl font-bold text-blue-600">¥{totalRevenue.toLocaleString()}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">营业成本+费用</p><p className="text-xl font-bold text-amber-600">¥{totalExpense.toLocaleString()}</p></CardContent></Card>
          <Card className={netProfit >= 0 ? 'border-green-200' : 'border-red-200'}>
            <CardContent className="p-4 text-center">
              <p className="text-xs text-muted-foreground">净利润</p>
              <p className={`text-xl font-bold flex items-center justify-center gap-1 ${netProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {netProfit >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                ¥{netProfit.toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">净利率</p><p className={`text-xl font-bold ${Number(margin) >= 15 ? 'text-green-600' : Number(margin) >= 0 ? 'text-amber-600' : 'text-red-600'}`}>{margin}%</p></CardContent></Card>
        </div>

        {/* 收入明细 */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">一、营业收入</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {revenueItems.length === 0 && <p className="text-muted-foreground text-center py-4">该期间暂无收入记录</p>}
            {revenueItems.map(item => (
              <div key={item.account_code} className="flex justify-between items-center">
                <span className="text-muted-foreground">{item.account_code} {item.account_name}</span>
                <span className="font-medium">¥{(item.period_credit - item.period_debit).toLocaleString()}</span>
              </div>
            ))}
            <Separator />
            <div className="flex justify-between font-semibold">
              <span>营业收入合计</span>
              <span className="text-blue-600">¥{totalRevenue.toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        {/* 成本费用明细 */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">二、营业成本及费用</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {expenseItems.length === 0 && <p className="text-muted-foreground text-center py-4">该期间暂无成本记录</p>}
            {expenseItems.map(item => (
              <div key={item.account_code} className="flex justify-between items-center">
                <span className="text-muted-foreground">{item.account_code} {item.account_name}</span>
                <span className="font-medium">¥{(item.period_debit - item.period_credit).toLocaleString()}</span>
              </div>
            ))}
            <Separator />
            <div className="flex justify-between font-semibold">
              <span>成本费用合计</span>
              <span className="text-amber-600">¥{totalExpense.toLocaleString()}</span>
            </div>
          </CardContent>
        </Card>

        {/* 净利润 */}
        <Card className={netProfit >= 0 ? 'border-green-300 bg-green-50/30' : 'border-red-300 bg-red-50/30'}>
          <CardContent className="p-6">
            <div className="flex justify-between items-center">
              <div>
                <p className="text-sm text-muted-foreground">三、净利润</p>
                <p className="text-xs text-muted-foreground mt-1">营业收入 - 营业成本 - 费用</p>
              </div>
              <p className={`text-3xl font-bold ${netProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                ¥{netProfit.toLocaleString()}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
