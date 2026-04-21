'use client'

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, CheckCircle, XCircle, Clock, Play, ShieldCheck, RefreshCw, Lock, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

// ---------- Types ----------
interface ClosingCheckItem {
  id: string
  checkKey: string
  checkLabel: string
  checkOrder: number
  status: 'pending' | 'passed' | 'failed' | 'skipped' | 'overridden'
  result: Record<string, unknown> | null
  executedAt: string | null
  overrideReason: string | null
}

interface ClosingResult {
  periodCode: string
  totalChecks: number
  passed: number
  failed: number
  overridden: number
  pending: number
  allClear: boolean
  items: ClosingCheckItem[]
}

const statusConfig = {
  pending:    { label: '待检查', variant: 'secondary' as const,    icon: Clock },
  passed:     { label: '通过',   variant: 'default' as const,      icon: CheckCircle },
  failed:     { label: '未通过', variant: 'destructive' as const,  icon: XCircle },
  overridden: { label: '已覆盖', variant: 'outline' as const,      icon: ShieldCheck },
  skipped:    { label: '已跳过', variant: 'secondary' as const,    icon: Clock },
}

// 生成最近 13 个月的期间列表
function generatePeriods(): { value: string; label: string }[] {
  const periods = []
  const now = new Date()
  for (let i = 0; i < 13; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    periods.push({ value, label: `${d.getFullYear()}年${d.getMonth() + 1}月` })
  }
  return periods
}

const periods = generatePeriods()

// ---------- Page ----------
export default function ClosingPage() {
  const [period, setPeriod] = useState(periods[1].value) // 上月
  const [data, setData] = useState<ClosingResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [runningKey, setRunningKey] = useState<string | null>(null)
  const [overrideItem, setOverrideItem] = useState<ClosingCheckItem | null>(null)
  const [overrideReason, setOverrideReason] = useState('')
  const [closing, setClosing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/control-center/closing?period=${period}`)
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setData(d.data)
    } catch (e) {
      toast.error(`加载失败: ${e instanceof Error ? e.message : '未知'}`)
    } finally {
      setLoading(false)
    }
  }, [period])

  useEffect(() => { load() }, [load])

  const initChecklist = async () => {
    try {
      const res = await fetch('/api/control-center/closing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'init', period, closeType: 'month' }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('检查项已初始化')
      load()
    } catch (e) { toast.error(`初始化失败: ${e instanceof Error ? e.message : '未知'}`) }
  }

  const runAll = async () => {
    setRunningKey('__all__')
    try {
      const res = await fetch('/api/control-center/closing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run_all', period }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setData(d.data)
      toast.success('全部检查完成')
    } catch (e) { toast.error(`检查失败: ${e instanceof Error ? e.message : '未知'}`) }
    setRunningKey(null)
  }

  const runOne = async (checkKey: string) => {
    setRunningKey(checkKey)
    try {
      const res = await fetch('/api/control-center/closing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run_one', period, checkKey }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      // 局部更新该检查项
      setData(prev => prev ? {
        ...prev,
        items: prev.items.map(item =>
          item.checkKey === checkKey ? { ...item, status: d.data.status, result: d.data.result, executedAt: d.data.executedAt } : item
        ),
      } : prev)
      toast.success(`检查完成: ${d.data.status === 'passed' ? '✅ 通过' : '❌ 未通过'}`)
    } catch (e) { toast.error(`检查失败: ${e instanceof Error ? e.message : '未知'}`) }
    setRunningKey(null)
  }

  const doOverride = async () => {
    if (!overrideItem || !overrideReason.trim()) { toast.error('请输入覆盖原因'); return }
    try {
      const res = await fetch('/api/control-center/closing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'override', period, checkKey: overrideItem.checkKey, reason: overrideReason }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      setData(prev => prev ? {
        ...prev,
        items: prev.items.map(item =>
          item.checkKey === overrideItem.checkKey ? { ...item, status: 'overridden', overrideReason } : item
        ),
      } : prev)
      toast.success('已人工覆盖')
      setOverrideItem(null)
      setOverrideReason('')
    } catch (e) { toast.error(`覆盖失败: ${e instanceof Error ? e.message : '未知'}`) }
  }

  const finalize = async () => {
    if (!data?.allClear) { toast.error('所有检查项必须通过或覆盖才能关账'); return }
    setClosing(true)
    try {
      const res = await fetch('/api/control-center/closing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finalize', period }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      toast.success(`✅ ${period} 已成功关账`)
      load()
    } catch (e) { toast.error(`关账失败: ${e instanceof Error ? e.message : '未知'}`) }
    setClosing(false)
  }

  const passedCount = data?.items.filter(i => i.status === 'passed' || i.status === 'overridden').length ?? 0
  const totalCount = data?.items.length ?? 0
  const allClear = data?.allClear ?? false
  const hasItems = totalCount > 0

  return (
    <div className="flex flex-col h-full">
      <Header title="月结中心" subtitle="期间关闭检查与控制" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* 控制栏 */}
        <div className="flex flex-wrap items-center gap-3">
          <Select value={period} onValueChange={v => setPeriod(v ?? period)}>
            <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>{periods.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
          </Select>

          {!hasItems ? (
            <Button onClick={initChecklist} variant="outline" size="sm">初始化检查项</Button>
          ) : (
            <Button onClick={runAll} disabled={runningKey === '__all__'} size="sm">
              {runningKey === '__all__' ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              一键检查
            </Button>
          )}

          <Button onClick={load} variant="ghost" size="sm"><RefreshCw className="h-4 w-4" /></Button>

          {/* 进度徽章 */}
          {hasItems && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-sm text-muted-foreground">{passedCount}/{totalCount} 通过</span>
              {allClear
                ? <Badge className="bg-green-600 text-white">✅ 可关账</Badge>
                : <Badge variant="secondary">待完成</Badge>
              }
            </div>
          )}
        </div>

        {/* KPI 卡片 */}
        {data && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: '总检查项', value: data.totalChecks, color: 'text-foreground' },
              { label: '通过', value: data.passed, color: 'text-green-600' },
              { label: '未通过', value: data.failed, color: 'text-red-600' },
              { label: '人工覆盖', value: data.overridden, color: 'text-amber-600' },
              { label: '待检查', value: data.pending, color: 'text-muted-foreground' },
            ].map(k => (
              <Card key={k.label}>
                <CardContent className="p-3 text-center">
                  <div className={`text-2xl font-bold ${k.color}`}>{k.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{k.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* 检查项表格 */}
        {loading && !data ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : !hasItems ? (
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              <AlertTriangle className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm">该期间尚未初始化检查项</p>
              <p className="text-xs mt-1">点击「初始化检查项」开始月结流程</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{period} 结账检查清单</CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>检查项</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.items ?? []).sort((a, b) => a.checkOrder - b.checkOrder).map(item => {
                  const cfg = statusConfig[item.status] ?? statusConfig.pending
                  const Icon = cfg.icon
                  const isRunning = runningKey === item.checkKey
                  const resultMsg = item.result
                    ? (item.result.message as string) || (item.status === 'passed' ? '检查通过' : '检查未通过')
                    : item.overrideReason ? `覆盖原因: ${item.overrideReason}` : '—'

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="text-muted-foreground text-xs">{item.checkOrder}</TableCell>
                      <TableCell className="font-medium">{item.checkLabel}</TableCell>
                      <TableCell>
                        <Badge variant={cfg.variant} className="whitespace-nowrap">
                          {isRunning ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Icon className="h-3 w-3 mr-1" />}
                          {isRunning ? '检查中...' : cfg.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-xs truncate">{resultMsg}</TableCell>
                      <TableCell className="text-right space-x-2">
                        <Button
                          size="sm" variant="outline"
                          onClick={() => runOne(item.checkKey)}
                          disabled={!!runningKey}
                        >
                          {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                        </Button>
                        {item.status === 'failed' && (
                          <Button size="sm" variant="ghost" onClick={() => setOverrideItem(item)}>
                            <ShieldCheck className="h-3 w-3 mr-1" />覆盖
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        )}

        {/* 关账按钮 */}
        {hasItems && (
          <div className="flex justify-end">
            <Button
              size="lg"
              disabled={!allClear || closing}
              onClick={finalize}
              className={allClear ? 'bg-green-600 hover:bg-green-700 text-white' : ''}
            >
              {closing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Lock className="h-4 w-4 mr-2" />}
              关闭 {period} 期间
            </Button>
          </div>
        )}
      </div>

      {/* 覆盖原因弹窗 */}
      <Dialog open={!!overrideItem} onOpenChange={o => { if (!o) { setOverrideItem(null); setOverrideReason('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>人工覆盖: {overrideItem?.checkLabel}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">该检查项未通过，请填写覆盖原因（将记录审计日志）：</p>
            <Textarea
              value={overrideReason}
              onChange={e => setOverrideReason(e.target.value)}
              placeholder="例：已确认相关差异属正常波动，财务总监已口头批准..."
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOverrideItem(null)}>取消</Button>
            <Button onClick={doOverride} disabled={!overrideReason.trim()}>确认覆盖</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
