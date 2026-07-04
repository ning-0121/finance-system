'use client'

import { useState } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Loader2, Play, Save, TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

interface SimResult {
  baseRevenue: number; simulatedRevenue: number; revenueChange: number
  baseProfit: number; simulatedProfit: number; profitChange: number
  baseMargin: number; simulatedMargin: number
  affectedOrders: { orderNo: string; customer: string; currentProfit: number; simulatedProfit: number }[]
  riskFlags: string[]; summary: string
}

// key = 引擎 scenarioType；params.key = parameters 里的字段名（须与后端一致）
const scenarios = [
  { key: 'fx_change', label: '汇率变化', params: [{ key: 'newRate', label: '新汇率', default: '6.9', type: 'number' }] },
  { key: 'cost_increase', label: '成本上涨', params: [{ key: 'costType', label: '成本类别', default: '面料' }, { key: 'percent', label: '上涨比例(%)', default: '10', type: 'number' }] },
  { key: 'customer_loss', label: '客户流失', params: [{ key: 'customerId', label: '客户ID', default: '' }] },
  { key: 'supply_disruption', label: '供应链中断', params: [{ key: 'supplierName', label: '供应商名称', default: '' }] },
] as const

const fmt = (n: number) => Math.abs(n) >= 10000 ? `${(n / 10000).toFixed(1)}万` : n.toFixed(0)

export default function SimulationPage() {
  const [activeTab, setActiveTab] = useState<string>('fx_change')
  const [params, setParams] = useState<Record<string, string>>({})
  const [result, setResult] = useState<SimResult | null>(null)
  const [loading, setLoading] = useState(false)

  const activeScenario = scenarios.find(s => s.key === activeTab)!

  // 构造 parameters：数字字段转 number
  const buildParameters = () => {
    const out: Record<string, unknown> = {}
    for (const p of activeScenario.params) {
      const raw = params[p.key] ?? p.default
      out[p.key] = 'type' in p && p.type === 'number' ? Number(raw) : raw
    }
    return out
  }

  const runSim = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/control-center/simulation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenarioType: activeTab, parameters: buildParameters() }) })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setResult(d.data)
      toast.success('模拟完成')
    } catch (e) { toast.error(`模拟失败: ${e instanceof Error ? e.message : '未知错误'}`) }
    finally { setLoading(false) }
  }

  const saveScenario = async () => {
    if (!result) return
    const name = prompt('给这个场景起个名字：', `${activeScenario.label} ${new Date().toLocaleDateString('zh-CN')}`)
    if (!name || !name.trim()) return
    try {
      const res = await fetch('/api/control-center/simulation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', name: name.trim(), scenarioType: activeTab, parameters: buildParameters(), result }) })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('场景已保存')
    } catch (e) { toast.error(`保存失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  const DiffCard = ({ label, before, after, isPct }: { label: string; before: number; after: number; isPct?: boolean }) => {
    const diff = after - before
    const isUp = diff >= 0
    const show = (n: number) => isPct ? `${n.toFixed(1)}%` : fmt(n)
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground mb-1">{label}</p>
          <div className="flex items-end gap-2">
            <span className="text-lg font-bold">{show(after)}</span>
            <span className={`text-sm flex items-center ${isUp ? 'text-green-600' : 'text-red-600'}`}>
              {isUp ? <TrendingUp className="h-3 w-3 mr-0.5" /> : <TrendingDown className="h-3 w-3 mr-0.5" />}
              {isUp ? '+' : ''}{isPct ? `${diff.toFixed(1)}%` : fmt(diff)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">原: {show(before)}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="沙盘模拟" subtitle="What-If 场景分析" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <Tabs value={activeTab} onValueChange={v => { setActiveTab(v); setResult(null); setParams({}) }}>
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
            {result.summary && <p className="text-sm text-muted-foreground">{result.summary}</p>}
            <div className="grid grid-cols-3 gap-4">
              <DiffCard label="营收" before={result.baseRevenue} after={result.simulatedRevenue} />
              <DiffCard label="利润" before={result.baseProfit} after={result.simulatedProfit} />
              <DiffCard label="利润率" before={result.baseMargin} after={result.simulatedMargin} isPct />
            </div>

            {result.affectedOrders.length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">受影响订单（{result.affectedOrders.length}）</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader><TableRow><TableHead>订单号</TableHead><TableHead>客户</TableHead><TableHead className="text-right">当前利润</TableHead><TableHead className="text-right">模拟利润</TableHead><TableHead className="text-right">变动</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {result.affectedOrders.map(o => {
                        const delta = o.simulatedProfit - o.currentProfit
                        return (
                          <TableRow key={o.orderNo}>
                            <TableCell className="font-mono text-xs">{o.orderNo}</TableCell>
                            <TableCell>{o.customer}</TableCell>
                            <TableCell className="text-right">{fmt(o.currentProfit)}</TableCell>
                            <TableCell className={`text-right ${o.simulatedProfit < 0 ? 'text-red-600 font-medium' : ''}`}>{fmt(o.simulatedProfit)}</TableCell>
                            <TableCell className={`text-right ${delta < 0 ? 'text-red-600' : 'text-green-600'}`}>{delta < 0 ? '' : '+'}{fmt(delta)}</TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {result.riskFlags.length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">风险提示</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {result.riskFlags.map((f, i) => (
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
