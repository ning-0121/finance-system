'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Lock, Unlock, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

type Period = {
  id: string
  period_code: string
  year: number
  month: number
  start_date: string
  end_date: string
  status: string
  closed_at: string | null
  close_notes: string | null
}

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  open: { label: '开放', color: 'bg-green-100 text-green-700' },
  closing: { label: '结账中', color: 'bg-amber-100 text-amber-700' },
  closed: { label: '已关闭', color: 'bg-gray-100 text-gray-700' },
}

export default function PeriodsPage() {
  const [periods, setPeriods] = useState<Period[]>([])
  const [loading, setLoading] = useState(true)
  const [closeDialog, setCloseDialog] = useState<Period | null>(null)
  const [closeNotes, setCloseNotes] = useState('')
  const [processing, setProcessing] = useState(false)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data } = await supabase.from('accounting_periods').select('*').order('period_code', { ascending: false })
      setPeriods((data as Period[]) || [])
      setLoading(false)
    }
    load()
  }, [])

  const handleClose = async () => {
    if (!closeDialog) return
    setProcessing(true)
    try {
      const supabase = createClient()
      const { data: profiles } = await supabase.from('profiles').select('id').limit(1)
      const { error } = await supabase.from('accounting_periods').update({
        status: 'closed',
        closed_by: profiles?.[0]?.id,
        closed_at: new Date().toISOString(),
        close_notes: closeNotes || null,
      }).eq('id', closeDialog.id)
      if (error) throw error
      setPeriods(periods.map(p => p.id === closeDialog.id ? { ...p, status: 'closed', closed_at: new Date().toISOString(), close_notes: closeNotes } : p))
      toast.success(`期间 ${closeDialog.period_code} 已关闭`)
      setCloseDialog(null)
      setCloseNotes('')
    } catch (err) {
      toast.error(`关闭失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
    setProcessing(false)
  }

  const handleReopen = async (period: Period) => {
    try {
      const supabase = createClient()
      const { error } = await supabase.from('accounting_periods').update({ status: 'open', closed_by: null, closed_at: null }).eq('id', period.id)
      if (error) throw error
      setPeriods(periods.map(p => p.id === period.id ? { ...p, status: 'open', closed_at: null } : p))
      toast.success(`期间 ${period.period_code} 已重新开放`)
    } catch (err) {
      toast.error(`操作失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const openCount = periods.filter(p => p.status === 'open').length
  const closedCount = periods.filter(p => p.status === 'closed').length

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="会计期间管理" subtitle="期间开放/关闭 · 关闭后禁止新增和修改凭证" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">总期间数</p><p className="text-2xl font-bold">{periods.length}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">开放期间</p><p className="text-2xl font-bold text-green-600">{openCount}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">已关闭</p><p className="text-2xl font-bold text-gray-600">{closedCount}</p></CardContent></Card>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>期间</TableHead>
                  <TableHead>起止日期</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>关闭时间</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead className="text-center">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {periods.map(p => {
                  const sc = STATUS_MAP[p.status] || STATUS_MAP.open
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-mono font-medium">{p.period_code}</TableCell>
                      <TableCell className="text-sm">{p.start_date} ~ {p.end_date}</TableCell>
                      <TableCell><Badge className={`${sc.color} border-0`}>{sc.label}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{p.closed_at ? new Date(p.closed_at).toLocaleString('zh-CN') : '-'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{p.close_notes || '-'}</TableCell>
                      <TableCell className="text-center">
                        {p.status === 'open' && (
                          <Button size="sm" variant="outline" onClick={() => setCloseDialog(p)}>
                            <Lock className="h-3.5 w-3.5 mr-1" />关闭期间
                          </Button>
                        )}
                        {p.status === 'closed' && (
                          <Button size="sm" variant="ghost" className="text-amber-600" onClick={() => handleReopen(p)}>
                            <Unlock className="h-3.5 w-3.5 mr-1" />重新开放
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {closeDialog && (
        <Dialog open onOpenChange={() => setCloseDialog(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>关闭会计期间 {closeDialog.period_code}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-2 p-3 bg-amber-50 rounded-lg text-amber-700 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>关闭后该期间将禁止新增和修改凭证，确保所有单据已入账</span>
              </div>
              <Textarea placeholder="关闭备注（选填）" value={closeNotes} onChange={e => setCloseNotes(e.target.value)} rows={3} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCloseDialog(null)}>取消</Button>
              <Button onClick={handleClose} disabled={processing}>
                {processing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Lock className="h-4 w-4 mr-1" />}
                确认关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
