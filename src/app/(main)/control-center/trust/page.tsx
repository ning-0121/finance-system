'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, RefreshCw, TrendingUp, TrendingDown, Minus, Shield } from 'lucide-react'
import { toast } from 'sonner'

type TrustLevel = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5'

interface LowTrust { subjectType: string; subjectId: string; score: number; level: TrustLevel; trend: string }
interface RecentChange { subjectType: string; subjectId: string; from: string; to: string; reason: string; changedAt: string }
interface TrustDashboard {
  summary: { total: number; byLevel: Record<TrustLevel, number>; recentDowngrades: number; recentUpgrades: number; frozenCount: number }
  lowTrust: LowTrust[]
  recentChanges: RecentChange[]
}

const levelColors: Record<TrustLevel, { bg: string; text: string; label: string }> = {
  T0: { bg: 'bg-red-100', text: 'text-red-700', label: 'T0 不可信' },
  T1: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'T1 低信任' },
  T2: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'T2 谨慎' },
  T3: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'T3 一般' },
  T4: { bg: 'bg-green-100', text: 'text-green-700', label: 'T4 可信' },
  T5: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'T5 高度可信' },
}
const LEVELS: TrustLevel[] = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5']
const typeLabel = (t: string) => t === 'customer' ? '客户' : t === 'supplier' ? '供应商' : t

const TrendIcon = ({ trend }: { trend: string }) => {
  if (trend === 'improving' || trend === 'up') return <TrendingUp className="h-4 w-4 text-green-500" />
  if (trend === 'declining' || trend === 'down') return <TrendingDown className="h-4 w-4 text-red-500" />
  return <Minus className="h-4 w-4 text-muted-foreground" />
}

export default function TrustPage() {
  const [dash, setDash] = useState<TrustDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [recalculating, setRecalculating] = useState(false)

  const load = () => {
    setLoading(true)
    fetch('/api/control-center/trust')
      .then(r => r.json()).then(d => setDash(d.data || null))
      .catch(() => toast.error('加载失败')).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const recalculate = async () => {
    setRecalculating(true)
    try {
      const res = await fetch('/api/control-center/trust', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'recalculate' }) })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('重新计算完成')
      load()
    } catch (e) { toast.error(`计算失败: ${e instanceof Error ? e.message : '未知错误'}`) }
    finally { setRecalculating(false) }
  }

  const byLevel = dash?.summary.byLevel
  const lowTrust = dash?.lowTrust ?? []
  const recentChanges = dash?.recentChanges ?? []

  return (
    <div className="flex flex-col h-full">
      <Header title="可信度中心" subtitle="实体信任评级管理" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            共 {dash?.summary.total ?? 0} 个实体 · 近7天 <span className="text-red-600">↓{dash?.summary.recentDowngrades ?? 0}</span> / <span className="text-green-600">↑{dash?.summary.recentUpgrades ?? 0}</span> · 冻结 {dash?.summary.frozenCount ?? 0}
          </span>
          <Button variant="outline" onClick={recalculate} disabled={recalculating}>
            {recalculating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}重新计算
          </Button>
        </div>

        <div className="grid grid-cols-6 gap-3">
          {LEVELS.map(l => {
            const cfg = levelColors[l]
            const count = byLevel?.[l] ?? 0
            return (
              <Card key={l} className={count > 0 && (l === 'T0' || l === 'T1') ? 'border-red-300' : ''}>
                <CardContent className="p-3 text-center">
                  <p className="text-2xl font-bold">{count}</p>
                  <Badge className={`${cfg.bg} ${cfg.text} text-[10px] mt-1`}>{cfg.label}</Badge>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <div>
              <h3 className="text-sm font-medium mb-2 flex items-center gap-1.5"><Shield className="h-4 w-4 text-red-400" />需关注实体（低信任）</h3>
              <Card>
                <Table>
                  <TableHeader><TableRow><TableHead>类型</TableHead><TableHead>实体ID</TableHead><TableHead>信任等级</TableHead><TableHead>信任分数</TableHead><TableHead>趋势</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {lowTrust.map(e => {
                      const cfg = levelColors[e.level] || levelColors.T3
                      return (
                        <TableRow key={`${e.subjectType}:${e.subjectId}`} className="bg-red-50/50">
                          <TableCell><Badge variant="outline">{typeLabel(e.subjectType)}</Badge></TableCell>
                          <TableCell className="font-mono text-xs">{e.subjectId}</TableCell>
                          <TableCell><Badge className={`${cfg.bg} ${cfg.text}`}>{e.level}</Badge></TableCell>
                          <TableCell className="font-mono">{e.score}</TableCell>
                          <TableCell><TrendIcon trend={e.trend} /></TableCell>
                        </TableRow>
                      )
                    })}
                    {lowTrust.length === 0 && (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground"><Shield className="h-8 w-8 mx-auto mb-2 text-green-300" />没有低信任实体</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </Card>
            </div>

            {recentChanges.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-2">近7天等级变动</h3>
                <Card>
                  <Table>
                    <TableHeader><TableRow><TableHead>类型</TableHead><TableHead>实体ID</TableHead><TableHead>变动</TableHead><TableHead>原因</TableHead><TableHead>时间</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {recentChanges.map((c, i) => (
                        <TableRow key={i}>
                          <TableCell><Badge variant="outline">{typeLabel(c.subjectType)}</Badge></TableCell>
                          <TableCell className="font-mono text-xs">{c.subjectId}</TableCell>
                          <TableCell className="text-sm">{c.from} → {c.to}</TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-[240px] truncate">{c.reason}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{c.changedAt ? new Date(c.changedAt).toLocaleString('zh-CN') : '-'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
