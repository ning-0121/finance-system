'use client'

// ============================================================
// Financial Integrity Center — 财务可信度中心（Phase 2 #3）
// 评分 + 四维度 + 总量盘点 + 勾稽检查矩阵 + 异常钻取 + 评分趋势
// 数据：integrity_runs（每日 cron 06:00 巡检 + 手动立即巡检）
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'

type Check = {
  key: string; label: string; status: 'passed' | 'failed'
  severity: 'critical' | 'warning' | 'info'
  count: number; varianceCny?: number; detail: string
  items?: { id: string; label: string }[]
}
type Run = {
  id: string; run_at: string; trigger: string; score: number
  dimension_scores: { completeness: number; consistency: number; uniqueness: number; timeliness: number }
  counts: Record<string, number>
  checks: Check[]
  critical_count: number; warning_count: number; info_count: number
  summary_text: string
}
type HistoryPoint = { run_at: string; score: number; critical_count: number }

const SEV_BADGE: Record<string, { label: string; cls: string }> = {
  critical: { label: '严重', cls: 'bg-red-100 text-red-700' },
  warning: { label: '警告', cls: 'bg-amber-100 text-amber-700' },
  info: { label: '提示', cls: 'bg-blue-100 text-blue-700' },
}
const COUNT_LABEL: Record<string, string> = {
  budget_orders: '预算单', settlements: '决算单', journal_entries: '凭证',
  receipts: '回款流水', supplier_payments: '付款流水', cost_items: '费用明细',
}
const DIM_LABEL: Record<string, string> = {
  completeness: '完整性', consistency: '一致性', uniqueness: '唯一性', timeliness: '及时性',
}

export default function IntegrityCenterPage() {
  const [latest, setLatest] = useState<Run | null>(null)
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/control-center/integrity?history=30')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      setLatest(j.latest)
      setHistory(j.history || [])
    } catch (e) {
      toast.error(`加载失败：${e instanceof Error ? e.message : '未知错误'}（若提示表不存在，请先执行迁移 20260611_integrity_runs.sql）`)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const runNow = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/control-center/integrity', { method: 'POST' })
      const j = await res.json()
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`)
      toast.success(`巡检完成：可信度 ${j.score}%`)
      await load()
    } catch (e) {
      toast.error(`巡检失败：${e instanceof Error ? e.message : '未知错误'}`)
    } finally { setRunning(false) }
  }

  const scoreColor = (s: number) => s >= 98 ? 'text-green-600' : s >= 95 ? 'text-amber-600' : 'text-red-600'

  return (
    <div className="flex flex-col h-full">
      <Header title="财务可信度中心" subtitle="勾稽巡检 · 缺失/重复/不一致检测 · 每日 09:00 自动巡检" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : !latest ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">
            <ShieldCheck className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>尚无巡检记录</p>
            <Button className="mt-4" onClick={runNow} disabled={running}>
              {running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}立即巡检
            </Button>
          </CardContent></Card>
        ) : (
          <>
            {/* 评分头 */}
            <Card className="border-l-4 border-l-primary">
              <CardContent className="p-4 flex flex-wrap items-center gap-6">
                <div>
                  <p className="text-xs text-muted-foreground">财务可信度评分</p>
                  <p className={`text-4xl font-bold ${scoreColor(Number(latest.score))}`}>{Number(latest.score).toFixed(1)}%</p>
                </div>
                <div className="flex gap-4 text-sm">
                  {Object.entries(latest.dimension_scores || {}).map(([k, v]) => (
                    <div key={k} className="text-center">
                      <p className="text-xs text-muted-foreground">{DIM_LABEL[k] || k}</p>
                      <p className={`font-semibold ${scoreColor(Number(v))}`}>{Number(v).toFixed(1)}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 text-xs">
                  {latest.critical_count > 0 && <Badge className="bg-red-100 text-red-700">严重 {latest.critical_count}</Badge>}
                  {latest.warning_count > 0 && <Badge className="bg-amber-100 text-amber-700">警告 {latest.warning_count}</Badge>}
                  {latest.info_count > 0 && <Badge className="bg-blue-100 text-blue-700">提示 {latest.info_count}</Badge>}
                  {latest.critical_count + latest.warning_count === 0 && <Badge className="bg-green-100 text-green-700">无严重/警告异常</Badge>}
                </div>
                <div className="ml-auto text-right">
                  <Button size="sm" onClick={runNow} disabled={running}>
                    {running ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}立即巡检
                  </Button>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    上次：{new Date(latest.run_at).toLocaleString('zh-CN')}（{latest.trigger === 'cron' ? '自动' : '手动'}）
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* 总量盘点 */}
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
              {Object.entries(latest.counts || {}).map(([k, v]) => (
                <Card key={k}><CardContent className="p-3 text-center">
                  <p className="text-xs text-muted-foreground">{COUNT_LABEL[k] || k}</p>
                  <p className="text-xl font-bold">{Number(v).toLocaleString()}</p>
                </CardContent></Card>
              ))}
            </div>

            {/* 勾稽检查矩阵 */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">勾稽检查矩阵</CardTitle></CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>检查链路</TableHead><TableHead>状态</TableHead><TableHead>级别</TableHead>
                    <TableHead className="text-right">异常数</TableHead><TableHead className="text-right">金额差异</TableHead><TableHead>说明</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {(latest.checks || []).map(c => (
                      <>
                        <TableRow key={c.key} className={c.items?.length ? 'cursor-pointer hover:bg-muted/40' : ''}
                          onClick={() => c.items?.length && setExpanded(expanded === c.key ? null : c.key)}>
                          <TableCell className="font-medium">{c.items && c.items.length > 0 && <span className="mr-1 text-muted-foreground">{expanded === c.key ? '▼' : '▶'}</span>}{c.label}</TableCell>
                          <TableCell>{c.status === 'passed'
                            ? <span className="inline-flex items-center text-green-600 text-sm"><CheckCircle2 className="h-4 w-4 mr-1" />通过</span>
                            : <span className="inline-flex items-center text-red-600 text-sm"><AlertTriangle className="h-4 w-4 mr-1" />异常</span>}</TableCell>
                          <TableCell>{c.status === 'failed' && <Badge className={SEV_BADGE[c.severity].cls}>{SEV_BADGE[c.severity].label}</Badge>}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.count || '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{c.varianceCny ? `¥${Number(c.varianceCny).toLocaleString()}` : '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[360px]">{c.detail}</TableCell>
                        </TableRow>
                        {expanded === c.key && (c.items || []).map((it, i) => (
                          <TableRow key={`${c.key}-${i}`} className="bg-muted/30">
                            <TableCell colSpan={6} className="pl-10 text-xs text-muted-foreground">· {it.label}</TableCell>
                          </TableRow>
                        ))}
                      </>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* 评分趋势（近30次） */}
            {history.length > 1 && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">评分趋势（近 {history.length} 次巡检）</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex items-end gap-1 h-24">
                    {history.map((h, i) => {
                      const pct = Math.max(4, (Number(h.score) - 80) / 20 * 100)
                      return (
                        <div key={i} className="flex-1 flex flex-col items-center" title={`${new Date(h.run_at).toLocaleDateString('zh-CN')} ${Number(h.score).toFixed(1)}%`}>
                          <div className={`w-full rounded-t ${h.critical_count > 0 ? 'bg-red-400' : Number(h.score) >= 98 ? 'bg-green-400' : 'bg-amber-400'}`} style={{ height: `${pct}%` }} />
                        </div>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2">绿色 ≥98 · 黄色 95–98 · 红色含严重异常（柱高按 80–100 区间缩放）</p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  )
}
