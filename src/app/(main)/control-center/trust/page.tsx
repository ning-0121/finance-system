'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, RefreshCw, TrendingUp, TrendingDown, Minus, Shield } from 'lucide-react'
import { toast } from 'sonner'

interface TrustEntity { id: string; entity_type: string; entity_name: string; trust_level: number; trust_score: number; trend: 'up' | 'down' | 'stable' }

const levelColors: Record<number, { bg: string; text: string; label: string }> = {
  0: { bg: 'bg-red-100', text: 'text-red-700', label: 'T0 - 不可信' },
  1: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'T1 - 低信任' },
  2: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'T2 - 谨慎' },
  3: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'T3 - 一般' },
  4: { bg: 'bg-green-100', text: 'text-green-700', label: 'T4 - 可信' },
  5: { bg: 'bg-emerald-100', text: 'text-emerald-700', label: 'T5 - 高度可信' },
}

const TrendIcon = ({ trend }: { trend: string }) => {
  if (trend === 'up') return <TrendingUp className="h-4 w-4 text-green-500" />
  if (trend === 'down') return <TrendingDown className="h-4 w-4 text-red-500" />
  return <Minus className="h-4 w-4 text-muted-foreground" />
}

export default function TrustPage() {
  const [entities, setEntities] = useState<TrustEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [recalculating, setRecalculating] = useState(false)
  const [entityFilter, setEntityFilter] = useState('all')

  const load = () => {
    setLoading(true)
    fetch('/api/control-center/trust')
      .then(r => r.json()).then(d => setEntities(d.entities || []))
      .catch(() => toast.error('加载失败')).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const recalculate = async () => {
    setRecalculating(true)
    try {
      const res = await fetch('/api/control-center/trust/recalculate', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('重新计算完成')
      load()
    } catch (e) { toast.error(`计算失败: ${e instanceof Error ? e.message : '未知错误'}`) }
    finally { setRecalculating(false) }
  }

  const filtered = entityFilter === 'all' ? entities : entities.filter(e => e.entity_type === entityFilter)
  const distribution = [0, 1, 2, 3, 4, 5].map(l => ({ level: l, count: entities.filter(e => e.trust_level === l).length }))

  return (
    <div className="flex flex-col h-full">
      <Header title="可信度中心" subtitle="实体信任评级管理" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-6 gap-3">
          {distribution.map(d => {
            const cfg = levelColors[d.level]
            return (
              <Card key={d.level} className={d.count > 0 && d.level <= 1 ? 'border-red-300' : ''}>
                <CardContent className="p-3 text-center">
                  <p className="text-2xl font-bold">{d.count}</p>
                  <Badge className={`${cfg.bg} ${cfg.text} text-[10px] mt-1`}>{cfg.label}</Badge>
                </CardContent>
              </Card>
            )
          })}
        </div>

        <div className="flex items-center justify-between">
          <Select value={entityFilter} onValueChange={v => setEntityFilter(v || 'all')}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="筛选类型" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              <SelectItem value="customer">客户</SelectItem>
              <SelectItem value="supplier">供应商</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={recalculate} disabled={recalculating}>
            {recalculating ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}重新计算
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <Card>
            <Table>
              <TableHeader><TableRow><TableHead>类型</TableHead><TableHead>名称</TableHead><TableHead>信任等级</TableHead><TableHead>信任分数</TableHead><TableHead>趋势</TableHead></TableRow></TableHeader>
              <TableBody>
                {filtered.map(e => {
                  const cfg = levelColors[e.trust_level] || levelColors[3]
                  const isLow = e.trust_level <= 1
                  return (
                    <TableRow key={e.id} className={isLow ? 'bg-red-50/50' : ''}>
                      <TableCell><Badge variant="outline">{e.entity_type}</Badge></TableCell>
                      <TableCell className="font-medium">{e.entity_name}</TableCell>
                      <TableCell><Badge className={`${cfg.bg} ${cfg.text}`}>T{e.trust_level}</Badge></TableCell>
                      <TableCell className="font-mono">{e.trust_score}</TableCell>
                      <TableCell><TrendIcon trend={e.trend} /></TableCell>
                    </TableRow>
                  )
                })}
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground"><Shield className="h-8 w-8 mx-auto mb-2 text-green-300" />没有实体数据</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
    </div>
  )
}
