'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, CheckCircle, XCircle, Clock, Play, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

interface Period { id: string; name: string; status: string }
interface CheckItem { id: string; check_label: string; status: 'pending' | 'passed' | 'failed' | 'overridden' }

const statusConfig = {
  pending: { label: '待检查', variant: 'secondary' as const, icon: Clock },
  passed: { label: '通过', variant: 'default' as const, icon: CheckCircle },
  failed: { label: '未通过', variant: 'destructive' as const, icon: XCircle },
  overridden: { label: '已覆盖', variant: 'outline' as const, icon: ShieldCheck },
}

export default function ClosingPage() {
  const [periods, setPeriods] = useState<Period[]>([])
  const [periodId, setPeriodId] = useState('')
  const [checks, setChecks] = useState<CheckItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/control-center/closing/periods')
      .then(r => r.json()).then(d => { setPeriods(d.periods || []); if (d.periods?.[0]) setPeriodId(d.periods[0].id) })
      .catch(() => toast.error('加载期间失败')).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!periodId) return
    setLoading(true)
    fetch(`/api/control-center/closing?period_id=${periodId}`)
      .then(r => r.json()).then(d => setChecks(d.checks || []))
      .catch(() => toast.error('加载检查项失败')).finally(() => setLoading(false))
  }, [periodId])

  const passedCount = checks.filter(c => c.status === 'passed' || c.status === 'overridden').length
  const canClose = checks.length > 0 && checks.every(c => c.status === 'passed' || c.status === 'overridden')

  const runCheck = async (id: string) => {
    try {
      const res = await fetch('/api/control-center/closing/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ check_id: id, period_id: periodId }) })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setChecks(prev => prev.map(c => c.id === id ? { ...c, status: d.status } : c))
      toast.success('检查完成')
    } catch (e) { toast.error(`检查失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  const overrideCheck = async (id: string) => {
    try {
      const res = await fetch('/api/control-center/closing/override', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ check_id: id, period_id: periodId }) })
      if (!res.ok) throw new Error((await res.json()).error)
      setChecks(prev => prev.map(c => c.id === id ? { ...c, status: 'overridden' } : c))
      toast.success('已覆盖')
    } catch (e) { toast.error(`覆盖失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  const closePeriod = async () => {
    try {
      const res = await fetch('/api/control-center/closing/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period_id: periodId }) })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('期间已关闭')
    } catch (e) { toast.error(`关闭失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="月结中心" subtitle="期间关闭检查与控制" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center gap-4">
          <Select value={periodId} onValueChange={v => setPeriodId(v || '')}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="选择期间" /></SelectTrigger>
            <SelectContent>{periods.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
          <Card><CardContent className="p-3 flex items-center gap-2"><CheckCircle className="h-4 w-4 text-green-500" /><span className="text-sm font-medium">{passedCount}/{checks.length} 通过</span></CardContent></Card>
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <Card>
              <Table>
                <TableHeader><TableRow><TableHead>检查项</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
                <TableBody>
                  {checks.map(c => {
                    const cfg = statusConfig[c.status]
                    const Icon = cfg.icon
                    return (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.check_label}</TableCell>
                        <TableCell><Badge variant={cfg.variant}><Icon className="h-3 w-3 mr-1" />{cfg.label}</Badge></TableCell>
                        <TableCell className="text-right space-x-2">
                          <Button size="sm" variant="outline" onClick={() => runCheck(c.id)}><Play className="h-3 w-3 mr-1" />运行</Button>
                          {c.status === 'failed' && <Button size="sm" variant="ghost" onClick={() => overrideCheck(c.id)}>覆盖</Button>}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Card>
            <div className="flex justify-end">
              <Button disabled={!canClose} onClick={closePeriod} size="lg">关闭期间</Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
