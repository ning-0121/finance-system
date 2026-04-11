'use client'

import { useState } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Loader2, Play, Save, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

interface SimResult { before: { revenue: number; profit: number; margin: number }; after: { revenue: number; profit: number; margin: number }; affected_orders: { id: string; name: string; impact: number }[]; risk_flags: string[] }

const scenarios = [
  { key: 'exchange_rate', label: '汇率变化', params: [{ key: 'currency', label: '币种', default: 'USD' }, { key: 'change_pct', label: '变化比例(%)', default: '-5' }] },
  { key: 'cost_increase', label: '成本上涨', params: [{ key: 'category', label: '成本类别', default: '原材料' }, { key: 'increase_pct', label: '上涨比例(%)', default: '10' }] },
  { key: 'customer_loss', label: '客户流失', params: [{ key: 'customer_id', label: '客户ID', default: '' }, { key: 'loss_pct', label: '流失比例(%)', default: '100' }] },
  { key: 'supply_disruption', label: '供应链中断', params: [{ key: 'supplier_id', label: '供应商ID', default: '' }, { key: 'duration_days', label: '中断天数', default: '30' }] },
]

const fmt = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toFixed(0)

export default function SimulationPage() {
  const [activeTab, setActiveTab] = useState('exchange_rate')
  const [params, setParams] = useState<Record<string, string>>({})
  const [result, setResult] = useState<SimResult | null>(null)
  const [loading, setLoading] = useState(false)

  const runSim = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/control-center/simulation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: activeTab, params }) })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setResult(d.result)
      toast.success('模拟完成')
    } catch (e) { toast.error(`模拟失败: ${e instanceof Error ? e.message : '未知错误'}`) }
    finally { setLoading(false) }
  }

  const saveScenario = async () => {
    try {
      const res = await fetch('/api/control-center/simulation/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: activeTab, params, result }) })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('场景已保存')
    } catch (e) { toast.error(`保存失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  const DiffCard = ({ label, before, after }: { label: string; before: number; after: number }) => {
    const diff = after - before
    const isUp = diff >= 0
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground mb-1">{label}</p>
          <div className="flex items-end gap-2">
            <span className="text-lg font-bold">{fmt(after)}</span>
            <span className={`text-sm flex items-center ${isUp ? 'text-green-600' : 'text-red-600'}`}>
              {isUp ? <TrendingUp className="h-3 w-3 mr-0.5" /> : <TrendingDown className="h-3 w-3 mr-0.5" />}
              {isUp ? '+' : ''}{fmt(diff)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">原: {fmt(before)}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="沙盘模拟" subtitle="What-If 场景分析" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <Tabs value={activeTab} onValueChange={v => { setActiveTab(v); setResult(null) }}>
          <TabsList>
            {scenarios.map(s => <TabsTrigger key={s.key} value={s.key}>{s.label}</TabsTrigger>)}
          </TabsList>
          {scenarios.map(s => (
            <TabsContent key={s.key} value={s.key} className="space-y-4 mt-4">
              <Card>
                <CardHeader><CardTitle className="text-base">{s.label}参数</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  {s.params.map(p => (
                    <div key={p.key} className="flex items-center gap-3">
                      <label className="text-sm w-28 shrink-0">{p.label}</label>
                      <Input className="max-w-xs" value={params[p.key] ?? p.default} onChange={e => setParams(prev => ({ ...prev, [p.key]: e.target.value }))} />
                    </div>
                  ))}
                  <Button onClick={runSim} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}模拟</Button>
                </CardContent>
              </Card>
            </TabsContent>
          ))}
        </Tabs>

        {result && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <DiffCard label="营收" before={result.before.revenue} after={result.after.revenue} />
              <DiffCard label="利润" before={result.before.profit} after={result.after.profit} />
              <DiffCard label="利润率(%)" before={result.before.margin} after={result.after.margin} />
            </div>

            {result.affected_orders.length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">受影响订单</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader><TableRow><TableHead>订单</TableHead><TableHead>名称</TableHead><TableHead className="text-right">影响金额</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {result.affected_orders.map(o => (
                        <TableRow key={o.id}><TableCell>{o.id}</TableCell><TableCell>{o.name}</TableCell><TableCell className={`text-right ${o.impact < 0 ? 'text-red-600' : 'text-green-600'}`}>{o.impact < 0 ? '' : '+'}{fmt(o.impact)}</TableCell></TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {result.risk_flags.length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">风险提示</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {result.risk_flags.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />{f}</div>
                  ))}
                </CardContent>
              </Card>
            )}

            <div className="flex justify-end"><Button variant="outline" onClick={saveScenario}><Save className="h-4 w-4 mr-1" />保存场景</Button></div>
          </div>
        )}
      </div>
    </div>
  )
}
