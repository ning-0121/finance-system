'use client'

// ============================================================
// 老板驾驶舱 — 全部真实数据，每个数字可下钻到来源页（无估算）
// 数据：/api/dashboard/boss（现金=银行账户真实余额；本月数=月结同口径；
// 风险客户/逾期取自异常中心）。取不到真数的指标直接不显示。
// ============================================================
import { useState, useEffect } from 'react'
import { Loader2, DollarSign, AlertTriangle, Users, ArrowUpRight, ArrowDownRight, Shield, Zap, Clock, TrendingUp, TrendingDown } from 'lucide-react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import Link from 'next/link'

interface BossData {
  asOf: string
  cash: { balance: number | null; hasBank: boolean; todayIn: number; todayOut: number }
  panel: { revenueCny: number; costCny: number; profitCny: number; marginPct: number; arBalanceCny: number; apBalanceCny: number; collectedCny: number; collectionRatePct: number; orderCount: number; settledCount: number }
  overdue: { arCny: number; customers: { name: string; amountCny: number; maxDays: number }[]; count: number; maxDays: number }
  weekPayables: { totalCny: number; list: { supplier: string; amount: number; due: string }[]; count: number }
  riskOrders: { list: { orderNo: string; customer: string; margin: number }[]; count: number; lossCount: number }
}
const fmt = (n: number) => `¥${Math.round(n).toLocaleString()}`

export default function BossDashboardPage() {
  const [d, setD] = useState<BossData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/dashboard/boss').then(async r => {
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setD(j)
    }).catch(e => setErr(e instanceof Error ? e.message : '加载失败')).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  if (err || !d) return (
    <div className="flex flex-col h-full"><Header title="老板驾驶舱" subtitle="实时经营快照" />
      <div className="flex-1 flex items-center justify-center"><Card className="max-w-sm"><CardContent className="py-12 text-center text-muted-foreground">{err || '无数据'}</CardContent></Card></div>
    </div>
  )

  const { cash, panel, overdue, weekPayables, riskOrders } = d

  return (
    <div className="flex flex-col h-full">
      <Header title="老板驾驶舱" subtitle={`经营实时快照 · 截至 ${d.asOf}`} />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* 今天 */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">今天</h2>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <Card className="border-l-4 border-l-blue-500">
              <CardContent className="p-4">
                <div className="p-2 rounded-lg bg-blue-50 w-fit mb-2"><DollarSign className="h-4 w-4 text-blue-600" /></div>
                <p className="text-xs text-muted-foreground">现金余额</p>
                {cash.balance == null
                  ? <><p className="text-lg font-bold text-muted-foreground">未接银行</p><Link href="/bank" className="text-[11px] text-primary hover:underline">去银行对账导入 →</Link></>
                  : <><p className="text-2xl font-bold">{fmt(cash.balance)}</p>
                      <div className="flex items-center gap-2 mt-1 text-[11px]">
                        <span className="text-green-600 flex items-center"><ArrowUpRight className="h-3 w-3" />今入 {fmt(cash.todayIn)}</span>
                        <span className="text-red-600 flex items-center"><ArrowDownRight className="h-3 w-3" />今出 {fmt(cash.todayOut)}</span>
                      </div></>}
              </CardContent>
            </Card>
            <KpiCard label="今日回款" value={fmt(cash.todayIn)} href="/receivables" tone="green" />
            <KpiCard label="今日付款" value={fmt(cash.todayOut)} href="/payments" tone="red" />
            <KpiCard label="应收余额" value={fmt(panel.arBalanceCny)} href="/receivables" tone="amber" />
            <KpiCard label="应付余额" value={fmt(panel.apBalanceCny)} href="/payables" tone="red" />
          </div>
        </div>

        {/* 本月 */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-2">本月（{d.asOf.slice(0, 7)}）</h2>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <Card><CardContent className="p-4">
              <p className="text-xs text-muted-foreground">本月利润</p>
              <p className={`text-2xl font-bold flex items-center gap-1 ${panel.profitCny >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {panel.profitCny >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}{fmt(panel.profitCny)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">收入 {fmt(panel.revenueCny)}</p>
            </CardContent></Card>
            <KpiCard label="毛利率" value={`${panel.marginPct}%`} href="/reports/actual-gross" tone={panel.marginPct >= 0 ? 'green' : 'red'} />
            <KpiCard label="回款率" value={`${panel.collectionRatePct}%`} sub={`回款 ${fmt(panel.collectedCny)}`} href="/receivables" tone="blue" />
            <KpiCard label="风险客户" value={`${overdue.count}`} sub={overdue.maxDays > 0 ? `最长逾期 ${overdue.maxDays} 天` : '无逾期'} href="/control-center/audit" tone="orange" />
            <KpiCard label="风险订单" value={`${riskOrders.count}`} sub={riskOrders.lossCount > 0 ? `${riskOrders.lossCount} 笔亏损` : '低毛利'} href="/control-center/audit" tone="purple" />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 高风险客户（逾期应收） */}
          <Card>
            <CardHeader className="pb-3"><div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4 text-red-500" />逾期应收 {fmt(overdue.arCny)}</CardTitle>
              <Link href="/receivables"><Button variant="ghost" size="sm">查看</Button></Link>
            </div></CardHeader>
            <CardContent className="space-y-2">
              {overdue.customers.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">暂无逾期客户 🎉</p>}
              {overdue.customers.map((c, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 bg-red-50/50 rounded-lg">
                  <div><span className="font-medium text-sm">{c.name}</span><p className="text-[11px] text-muted-foreground mt-0.5">逾期 {c.maxDays} 天</p></div>
                  <p className="font-semibold text-red-600 text-sm">{fmt(c.amountCny)}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 本周必付 */}
          <Card>
            <CardHeader className="pb-3"><div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><Clock className="h-4 w-4 text-amber-500" />本周必付 {fmt(weekPayables.totalCny)}</CardTitle>
              <Link href="/payments"><Button variant="ghost" size="sm">查看</Button></Link>
            </div></CardHeader>
            <CardContent className="space-y-2">
              {weekPayables.list.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">本周无到期应付</p>}
              {weekPayables.list.map((p, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 bg-amber-50/50 rounded-lg">
                  <div><span className="text-sm font-medium">{p.supplier}</span><p className="text-[11px] text-muted-foreground mt-0.5">{p.due} 到期</p></div>
                  <p className="font-semibold text-sm">¥{p.amount.toLocaleString()}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 风险订单 */}
          <Card>
            <CardHeader className="pb-3"><div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4 text-purple-500" />风险订单</CardTitle>
              <Link href="/orders"><Button variant="ghost" size="sm">查看</Button></Link>
            </div></CardHeader>
            <CardContent className="space-y-2">
              {riskOrders.list.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">无低毛利/亏损订单 🎉</p>}
              {riskOrders.list.map((o, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 bg-purple-50/50 rounded-lg">
                  <div><span className="text-sm font-medium">{o.orderNo}</span><p className="text-[11px] text-muted-foreground mt-0.5">{o.customer}</p></div>
                  <p className={`font-semibold text-sm ${o.margin < 0 ? 'text-red-600' : 'text-amber-600'}`}>{o.margin}%</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Users className="h-3 w-3" />所有数字来自真实业务表：现金=银行账户余额(银行对账)、本月经营=月结同口径、逾期=异常中心。点卡片可下钻来源页。</p>
      </div>
    </div>
  )
}

function KpiCard({ label, value, sub, href, tone }: { label: string; value: string; sub?: string; href?: string; tone?: 'green' | 'red' | 'amber' | 'blue' | 'orange' | 'purple' }) {
  const toneCls: Record<string, string> = { green: 'text-green-600', red: 'text-red-600', amber: 'text-amber-600', blue: 'text-blue-600', orange: 'text-orange-600', purple: 'text-purple-600' }
  const inner = (
    <CardContent className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-2xl font-bold ${tone ? toneCls[tone] : ''}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>}
    </CardContent>
  )
  return href ? <Link href={href}><Card className="hover:border-primary/40 transition cursor-pointer h-full">{inner}</Card></Link> : <Card>{inner}</Card>
}
