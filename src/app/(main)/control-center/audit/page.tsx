'use client'

// ============================================================
// Financial Exception Center — 财务异常中心（Phase 2 #4）
// audit_findings 工单池上的处理闭环：三级分类 + 状态流（待处理→处理中→
// 已解决/已忽略）+ 认领/解决/忽略 + 证据钻取。每日 cron 自动扫描喂入。
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, AlertTriangle, AlertCircle, Info, CheckCircle, ChevronDown, ChevronUp, Play, Hand, XCircle } from 'lucide-react'
import { toast } from 'sonner'

interface Finding {
  id: string; findingType: string; severity: 'critical' | 'warning' | 'info'
  entityType: string; entityId: string | null; title: string; description: string
  evidence: Record<string, unknown> | null
  status: 'open' | 'investigating' | 'resolved' | 'dismissed'
  resolutionNote: string | null; createdAt: string
}

const SEV = {
  critical: { label: '严重', icon: AlertCircle, badge: 'bg-red-100 text-red-700', bar: 'border-l-red-500', text: 'text-red-600' },
  warning: { label: '警告', icon: AlertTriangle, badge: 'bg-amber-100 text-amber-700', bar: 'border-l-amber-500', text: 'text-amber-600' },
  info: { label: '提示', icon: Info, badge: 'bg-blue-100 text-blue-700', bar: 'border-l-blue-500', text: 'text-blue-600' },
}
const STATUS_LABEL: Record<string, string> = { open: '待处理', investigating: '处理中', resolved: '已解决', dismissed: '已忽略' }
// 实体类型 → 可跳转页面
const ENTITY_LINK: Record<string, (id: string) => string> = {
  budget_order: id => `/orders/${id}`,
  payable_record: () => `/payments`,
  receivable_payment: () => `/receivables`,
}

export default function ExceptionCenterPage() {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [sevTab, setSevTab] = useState<'all' | 'critical' | 'warning' | 'info'>('all')
  const [statusTab, setStatusTab] = useState<'active' | 'resolved' | 'dismissed'>('active')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<{ mode: 'resolve' | 'dismiss'; finding: Finding } | null>(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/control-center/audit')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const d = await r.json()
      setFindings(d.data || [])
    } catch (e) { toast.error(`加载失败：${e instanceof Error ? e.message : '未知'}（若提示列不存在，请先执行迁移 20260612_exception_center_workflow.sql）`) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const post = async (body: Record<string, unknown>, okMsg: string) => {
    const res = await fetch('/api/control-center/audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    toast.success(okMsg)
  }

  const runScan = async () => {
    setRunning(true)
    try { await post({ action: 'run_full' }, '异常扫描完成'); await load() }
    catch (e) { toast.error(`扫描失败：${e instanceof Error ? e.message : '未知'}`) }
    finally { setRunning(false) }
  }
  const claim = async (f: Finding) => {
    try { await post({ action: 'claim', findingId: f.id }, '已认领'); await load() }
    catch (e) { toast.error(`认领失败：${e instanceof Error ? e.message : '未知'}`) }
  }
  const submitDialog = async () => {
    if (!dialog || !note.trim()) { toast.error(dialog?.mode === 'resolve' ? '请填写处理说明' : '请填写忽略原因'); return }
    setSubmitting(true)
    try {
      if (dialog.mode === 'resolve') await post({ action: 'resolve', findingId: dialog.finding.id, resolution: note.trim() }, '已解决')
      else await post({ action: 'dismiss', findingId: dialog.finding.id, reason: note.trim() }, '已忽略')
      setDialog(null); setNote(''); await load()
    } catch (e) { toast.error(`操作失败：${e instanceof Error ? e.message : '未知'}`) }
    finally { setSubmitting(false) }
  }
  const toggle = (id: string) => setExpanded(p => { const s = new Set(p); s.has(id) ? s.delete(id) : s.add(id); return s })

  const active = findings.filter(f => f.status === 'open' || f.status === 'investigating')
  const counts = {
    critical: active.filter(f => f.severity === 'critical').length,
    warning: active.filter(f => f.severity === 'warning').length,
    info: active.filter(f => f.severity === 'info').length,
  }
  const byStatus = statusTab === 'active' ? active : findings.filter(f => f.status === statusTab)
  const filtered = sevTab === 'all' ? byStatus : byStatus.filter(f => f.severity === sevTab)

  return (
    <div className="flex flex-col h-full">
      <Header title="异常中心" subtitle="自动扫描 · 三级分类 · 认领→解决/忽略闭环 · 每日 09:00 巡检" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="grid grid-cols-3 gap-3">
            {(['critical', 'warning', 'info'] as const).map(s => (
              <Card key={s} className={`border-l-4 ${SEV[s].bar}`}><CardContent className="p-3 text-center min-w-[88px]">
                <p className={`text-2xl font-bold ${SEV[s].text}`}>{counts[s]}</p>
                <p className="text-xs text-muted-foreground">{SEV[s].label}（待办）</p>
              </CardContent></Card>
            ))}
          </div>
          <Button onClick={runScan} disabled={running}>{running ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />}重新扫描</Button>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <Tabs value={sevTab} onValueChange={v => setSevTab(v as typeof sevTab)}>
            <TabsList>
              <TabsTrigger value="all">全部</TabsTrigger>
              <TabsTrigger value="critical">严重 ({counts.critical})</TabsTrigger>
              <TabsTrigger value="warning">警告 ({counts.warning})</TabsTrigger>
              <TabsTrigger value="info">提示 ({counts.info})</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={statusTab} onValueChange={v => setStatusTab(v as typeof statusTab)}>
            <TabsList>
              <TabsTrigger value="active">待处理/处理中</TabsTrigger>
              <TabsTrigger value="resolved">已解决</TabsTrigger>
              <TabsTrigger value="dismissed">已忽略</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <Card>
            <Table>
              <TableHeader><TableRow>
                <TableHead>级别</TableHead><TableHead>异常</TableHead><TableHead>状态</TableHead>
                <TableHead>时间</TableHead><TableHead className="text-right">操作</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {filtered.map(f => {
                  const cfg = SEV[f.severity]; const Icon = cfg.icon; const isOpen = expanded.has(f.id)
                  const link = f.entityId && ENTITY_LINK[f.entityType]?.(f.entityId)
                  return (
                    <>
                      <TableRow key={f.id} className="cursor-pointer hover:bg-muted/40" onClick={() => toggle(f.id)}>
                        <TableCell><Badge className={cfg.badge}><Icon className="h-3 w-3 mr-1" />{cfg.label}</Badge></TableCell>
                        <TableCell><span className="font-medium text-sm">{f.title}</span><span className="block text-xs text-muted-foreground">{f.findingType}</span></TableCell>
                        <TableCell><Badge variant="outline" className="text-xs">{STATUS_LABEL[f.status]}</Badge></TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{new Date(f.createdAt).toLocaleDateString('zh-CN')}</TableCell>
                        <TableCell className="text-right space-x-1" onClick={e => e.stopPropagation()}>
                          {f.status === 'open' && <Button size="sm" variant="outline" className="h-7" onClick={() => claim(f)}><Hand className="h-3 w-3 mr-1" />认领</Button>}
                          {(f.status === 'open' || f.status === 'investigating') && <>
                            <Button size="sm" variant="outline" className="h-7" onClick={() => { setDialog({ mode: 'resolve', finding: f }); setNote('') }}><CheckCircle className="h-3 w-3 mr-1" />解决</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => { setDialog({ mode: 'dismiss', finding: f }); setNote('') }}><XCircle className="h-3 w-3 mr-1" />忽略</Button>
                          </>}
                          {isOpen ? <ChevronUp className="h-4 w-4 inline" /> : <ChevronDown className="h-4 w-4 inline" />}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${f.id}-d`}><TableCell colSpan={5} className="bg-muted/40 text-sm">
                          <p>{f.description}</p>
                          {link && <a href={link} className="text-primary underline text-xs mt-1 inline-block">跳转查看单据 →</a>}
                          {f.resolutionNote && <p className="mt-2 text-xs text-muted-foreground">处理说明：{f.resolutionNote}</p>}
                          {f.evidence && <pre className="mt-2 text-[11px] text-muted-foreground bg-background/60 p-2 rounded overflow-x-auto max-h-40">{JSON.stringify(f.evidence, null, 2)}</pre>}
                        </TableCell></TableRow>
                      )}
                    </>
                  )
                })}
                {filtered.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">该分类下无异常 🎉</TableCell></TableRow>}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      {dialog && (
        <Dialog open onOpenChange={() => setDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{dialog.mode === 'resolve' ? '标记已解决' : '忽略此异常'} — {dialog.finding.title}</DialogTitle></DialogHeader>
            <div className="space-y-2 py-2">
              <p className="text-sm text-muted-foreground">{dialog.finding.description}</p>
              <Textarea rows={3} placeholder={dialog.mode === 'resolve' ? '处理说明（必填，审计留痕）：如已与供应商核对、已补登记等' : '忽略原因（必填）：如确认为正常业务、误报等'} value={note} onChange={e => setNote(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)}>取消</Button>
              <Button onClick={submitDialog} disabled={submitting}>{submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}确认{dialog.mode === 'resolve' ? '解决' : '忽略'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
