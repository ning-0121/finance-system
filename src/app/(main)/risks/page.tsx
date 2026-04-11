'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AlertTriangle, CheckCircle, Clock, Shield, Loader2, Eye } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { RISK_TYPE_LABELS, type FinancialRiskEvent, type RiskLevel } from '@/lib/types/agent'

const demoRisks: FinancialRiskEvent[] = []

const riskLevelConfig: Record<RiskLevel, { label: string; color: string; bg: string }> = {
  red: { label: '严重', color: 'text-red-700', bg: 'bg-red-50 border-red-200' },
  yellow: { label: '关注', color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
  green: { label: '正常', color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
}

export default function RisksPage() {
  const [risks, setRisks] = useState<FinancialRiskEvent[]>(demoRisks)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const { data } = await supabase
          .from('financial_risk_events')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50)
        if (data?.length) setRisks(data as FinancialRiskEvent[])
      } catch { /* demo fallback */ }
      setLoading(false)
    }
    load()
  }, [])

  const filtered = filter === 'all' ? risks
    : filter === 'active' ? risks.filter(r => r.status === 'pending' || r.status === 'processing')
    : risks.filter(r => r.risk_level === filter)

  const redCount = risks.filter(r => r.risk_level === 'red' && r.status !== 'resolved').length
  const yellowCount = risks.filter(r => r.risk_level === 'yellow' && r.status !== 'resolved').length
  const pendingCount = risks.filter(r => r.status === 'pending').length

  const handleResolve = async (id: string) => {
    try {
      const supabase = createClient()
      const { error } = await supabase.from('financial_risk_events').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', id)
      if (error) throw error
      setRisks(risks.map(r => r.id === id ? { ...r, status: 'resolved' as const, resolved_at: new Date().toISOString() } : r))
      toast.success('风险已标记为已处理')
    } catch (err) { toast.error(`操作失败: ${err instanceof Error ? err.message : '未知错误'}`) }
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="风险地图" subtitle="AI Agent 自动识别 · 红黄绿三级预警" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* 风险地图概览 */}
        <div className="grid grid-cols-4 gap-4">
          <Card className="border-l-4 border-l-red-500 cursor-pointer hover:shadow-md" onClick={() => setFilter('red')}>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-red-600">{redCount}</p>
              <p className="text-xs text-muted-foreground mt-1">🔴 必须处理</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-amber-500 cursor-pointer hover:shadow-md" onClick={() => setFilter('yellow')}>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-amber-600">{yellowCount}</p>
              <p className="text-xs text-muted-foreground mt-1">🟡 建议关注</p>
            </CardContent>
          </Card>
          <Card className="border-l-4 border-l-green-500 cursor-pointer hover:shadow-md" onClick={() => setFilter('green')}>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold text-green-600">{risks.filter(r => r.risk_level === 'green').length}</p>
              <p className="text-xs text-muted-foreground mt-1">🟢 正常</p>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-md" onClick={() => setFilter('active')}>
            <CardContent className="p-4 text-center">
              <p className="text-3xl font-bold">{pendingCount}</p>
              <p className="text-xs text-muted-foreground mt-1">⏳ 待处理</p>
            </CardContent>
          </Card>
        </div>

        {/* 筛选 */}
        <Tabs value={filter} onValueChange={setFilter}>
          <TabsList>
            <TabsTrigger value="all">全部 ({risks.length})</TabsTrigger>
            <TabsTrigger value="active">待处理 ({pendingCount})</TabsTrigger>
            <TabsTrigger value="red">严重 ({redCount})</TabsTrigger>
            <TabsTrigger value="yellow">关注 ({yellowCount})</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 风险列表 */}
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            {filtered.map(risk => {
              const cfg = riskLevelConfig[risk.risk_level]
              return (
                <Card key={risk.id} className={`border-l-4 ${cfg.bg}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={risk.risk_level === 'red' ? 'destructive' : risk.risk_level === 'yellow' ? 'secondary' : 'outline'} className="text-[10px]">
                            {cfg.label}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            {RISK_TYPE_LABELS[risk.risk_type]}
                          </Badge>
                          {risk.status === 'resolved' && (
                            <Badge className="bg-green-100 text-green-700 text-[10px]"><CheckCircle className="h-3 w-3 mr-0.5" />已处理</Badge>
                          )}
                          {risk.status === 'processing' && (
                            <Badge className="bg-blue-100 text-blue-700 text-[10px]"><Clock className="h-3 w-3 mr-0.5" />处理中</Badge>
                          )}
                        </div>
                        <h4 className="font-semibold text-sm">{risk.title}</h4>
                        <p className="text-xs text-muted-foreground mt-1">{risk.description}</p>
                        {risk.suggested_action && (
                          <div className="flex items-center gap-1 mt-2 text-xs text-primary">
                            <Shield className="h-3 w-3" />
                            <span>建议: {risk.suggested_action}</span>
                          </div>
                        )}
                        <p className="text-[10px] text-muted-foreground mt-2">
                          {new Date(risk.created_at).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      {risk.status === 'pending' && (
                        <div className="flex gap-1 shrink-0">
                          <Button size="sm" variant="outline" onClick={() => handleResolve(risk.id)}>
                            <CheckCircle className="h-3.5 w-3.5 mr-1" />已处理
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
            {filtered.length === 0 && (
              <div className="text-center py-16 text-muted-foreground">
                <Shield className="h-12 w-12 mx-auto mb-3 text-green-300" />
                <p>没有匹配的风险事件</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
