'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, AlertTriangle, AlertCircle, Info, CheckCircle, ChevronDown, ChevronUp, Play } from 'lucide-react'
import { toast } from 'sonner'

interface Finding { id: string; severity: 'critical' | 'warning' | 'info'; finding_type: string; entity: string; title: string; description: string; evidence: string; created_at: string; resolved: boolean }

const severityConfig = {
  critical: { label: '严重', variant: 'destructive' as const, icon: AlertCircle, color: 'text-red-600' },
  warning: { label: '警告', variant: 'secondary' as const, icon: AlertTriangle, color: 'text-amber-600' },
  info: { label: '信息', variant: 'outline' as const, icon: Info, color: 'text-blue-600' },
}

export default function AuditPage() {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [tab, setTab] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = () => {
    setLoading(true)
    fetch('/api/control-center/audit')
      .then(r => r.json()).then(d => setFindings(d.findings || []))
      .catch(() => toast.error('加载失败')).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const runAudit = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/control-center/audit/run', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('稽核完成')
      load()
    } catch (e) { toast.error(`稽核失败: ${e instanceof Error ? e.message : '未知错误'}`) }
    finally { setRunning(false) }
  }

  const resolve = async (id: string) => {
    try {
      const res = await fetch('/api/control-center/audit/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      if (!res.ok) throw new Error((await res.json()).error)
      setFindings(prev => prev.map(f => f.id === id ? { ...f, resolved: true } : f))
      toast.success('已标记处理')
    } catch (e) { toast.error(`操作失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  const toggle = (id: string) => setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const filtered = tab === 'all' ? findings : tab === 'resolved' ? findings.filter(f => f.resolved) : findings.filter(f => f.severity === tab && !f.resolved)
  const criticalCount = findings.filter(f => f.severity === 'critical' && !f.resolved).length
  const warningCount = findings.filter(f => f.severity === 'warning' && !f.resolved).length
  const infoCount = findings.filter(f => f.severity === 'info' && !f.resolved).length

  return (
    <div className="flex flex-col h-full">
      <Header title="财务稽核" subtitle="自动化合规检查与异常发现" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="grid grid-cols-3 gap-4">
            <Card className="border-l-4 border-l-red-500"><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-red-600">{criticalCount}</p><p className="text-xs text-muted-foreground">严重</p></CardContent></Card>
            <Card className="border-l-4 border-l-amber-500"><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-amber-600">{warningCount}</p><p className="text-xs text-muted-foreground">警告</p></CardContent></Card>
            <Card className="border-l-4 border-l-blue-500"><CardContent className="p-3 text-center"><p className="text-2xl font-bold text-blue-600">{infoCount}</p><p className="text-xs text-muted-foreground">信息</p></CardContent></Card>
          </div>
          <Button onClick={runAudit} disabled={running}>{running ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}运行稽核</Button>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="all">全部 ({findings.length})</TabsTrigger>
            <TabsTrigger value="critical">严重 ({criticalCount})</TabsTrigger>
            <TabsTrigger value="warning">警告 ({warningCount})</TabsTrigger>
            <TabsTrigger value="resolved">已处理 ({findings.filter(f => f.resolved).length})</TabsTrigger>
          </TabsList>
        </Tabs>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <Card>
            <Table>
              <TableHeader><TableRow><TableHead>级别</TableHead><TableHead>类型</TableHead><TableHead>实体</TableHead><TableHead>标题</TableHead><TableHead>时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {filtered.map(f => {
                  const cfg = severityConfig[f.severity]
                  const Icon = cfg.icon
                  const isOpen = expanded.has(f.id)
                  return (
                    <>
                      <TableRow key={f.id} className="cursor-pointer" onClick={() => toggle(f.id)}>
                        <TableCell><Badge variant={cfg.variant}><Icon className="h-3 w-3 mr-1" />{cfg.label}</Badge></TableCell>
                        <TableCell className="text-sm">{f.finding_type}</TableCell>
                        <TableCell className="text-sm">{f.entity}</TableCell>
                        <TableCell className="text-sm font-medium">{f.title}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleDateString('zh-CN')}</TableCell>
                        <TableCell className="text-right space-x-2">
                          {!f.resolved && <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); resolve(f.id) }}><CheckCircle className="h-3 w-3 mr-1" />处理</Button>}
                          {isOpen ? <ChevronUp className="h-4 w-4 inline" /> : <ChevronDown className="h-4 w-4 inline" />}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${f.id}-detail`}><TableCell colSpan={6} className="bg-muted/50 text-sm"><p>{f.description}</p>{f.evidence && <p className="mt-2 text-xs text-muted-foreground">证据: {f.evidence}</p>}</TableCell></TableRow>
                      )}
                    </>
                  )
                })}
                {filtered.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">没有稽核发现</TableCell></TableRow>}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
    </div>
  )
}
