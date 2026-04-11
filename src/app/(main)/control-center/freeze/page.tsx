'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Lock, Unlock, Plus, Snowflake } from 'lucide-react'
import { toast } from 'sonner'

interface FreezeRecord { id: string; entity_type: string; entity_id: string; entity_name: string; freeze_reason: string; frozen_at: string; status: 'frozen' | 'unfreeze_requested' | 'unfrozen' }

export default function FreezePage() {
  const [records, setRecords] = useState<FreezeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('all')
  const [showDialog, setShowDialog] = useState(false)
  const [form, setForm] = useState({ entity_type: 'customer', entity_id: '', entity_name: '', reason: '' })

  const load = () => {
    setLoading(true)
    fetch('/api/control-center/freeze')
      .then(r => r.json()).then(d => setRecords(d.records || []))
      .catch(() => toast.error('加载失败')).finally(() => setLoading(false))
  }
  useEffect(load, [])

  const freeze = async () => {
    try {
      const res = await fetch('/api/control-center/freeze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('已冻结')
      setShowDialog(false)
      setForm({ entity_type: 'customer', entity_id: '', entity_name: '', reason: '' })
      load()
    } catch (e) { toast.error(`冻结失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  const requestUnfreeze = async (id: string) => {
    try {
      const res = await fetch('/api/control-center/freeze/unfreeze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'request' }) })
      if (!res.ok) throw new Error((await res.json()).error)
      setRecords(prev => prev.map(r => r.id === id ? { ...r, status: 'unfreeze_requested' } : r))
      toast.success('解冻申请已提交')
    } catch (e) { toast.error(`申请失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  const approveUnfreeze = async (id: string) => {
    try {
      const res = await fetch('/api/control-center/freeze/unfreeze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: 'approve' }) })
      if (!res.ok) throw new Error((await res.json()).error)
      setRecords(prev => prev.map(r => r.id === id ? { ...r, status: 'unfrozen' } : r))
      toast.success('已解冻')
    } catch (e) { toast.error(`解冻失败: ${e instanceof Error ? e.message : '未知错误'}`) }
  }

  const filtered = tab === 'all' ? records : records.filter(r => r.entity_type === tab)
  const frozenCount = records.filter(r => r.status === 'frozen').length
  const byType = (t: string) => records.filter(r => r.entity_type === t && r.status === 'frozen').length

  return (
    <div className="flex flex-col h-full">
      <Header title="冻结控制" subtitle="实体冻结与解冻管理" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="grid grid-cols-4 gap-4">
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold">{frozenCount}</p><p className="text-xs text-muted-foreground">总冻结</p></CardContent></Card>
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold">{byType('customer')}</p><p className="text-xs text-muted-foreground">客户</p></CardContent></Card>
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold">{byType('supplier')}</p><p className="text-xs text-muted-foreground">供应商</p></CardContent></Card>
            <Card><CardContent className="p-3 text-center"><p className="text-2xl font-bold">{byType('order')}</p><p className="text-xs text-muted-foreground">订单</p></CardContent></Card>
          </div>
          <Button onClick={() => setShowDialog(true)}><Plus className="h-4 w-4 mr-1" />冻结实体</Button>
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="all">全部</TabsTrigger>
            <TabsTrigger value="customer">客户</TabsTrigger>
            <TabsTrigger value="supplier">供应商</TabsTrigger>
            <TabsTrigger value="order">订单</TabsTrigger>
          </TabsList>
        </Tabs>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <Card>
            <Table>
              <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>类型</TableHead><TableHead>原因</TableHead><TableHead>冻结时间</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>
                {filtered.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.entity_name}</TableCell>
                    <TableCell><Badge variant="outline">{r.entity_type}</Badge></TableCell>
                    <TableCell className="text-sm">{r.freeze_reason}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(r.frozen_at).toLocaleDateString('zh-CN')}</TableCell>
                    <TableCell>
                      <Badge variant={r.status === 'frozen' ? 'destructive' : r.status === 'unfreeze_requested' ? 'secondary' : 'default'}>
                        {r.status === 'frozen' ? '已冻结' : r.status === 'unfreeze_requested' ? '待解冻' : '已解冻'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {r.status === 'frozen' && <Button size="sm" variant="outline" onClick={() => requestUnfreeze(r.id)}><Unlock className="h-3 w-3 mr-1" />申请解冻</Button>}
                      {r.status === 'unfreeze_requested' && <Button size="sm" variant="outline" onClick={() => approveUnfreeze(r.id)}><Unlock className="h-3 w-3 mr-1" />批准</Button>}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground"><Snowflake className="h-8 w-8 mx-auto mb-2 text-blue-300" />没有冻结记录</TableCell></TableRow>}
              </TableBody>
            </Table>
          </Card>
        )}

        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent>
            <DialogHeader><DialogTitle>冻结实体</DialogTitle></DialogHeader>
            <div className="space-y-4">
              <Select value={form.entity_type} onValueChange={v => setForm(f => ({ ...f, entity_type: v || '' }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="customer">客户</SelectItem>
                  <SelectItem value="supplier">供应商</SelectItem>
                  <SelectItem value="order">订单</SelectItem>
                </SelectContent>
              </Select>
              <Input placeholder="实体ID" value={form.entity_id} onChange={e => setForm(f => ({ ...f, entity_id: e.target.value }))} />
              <Input placeholder="实体名称" value={form.entity_name} onChange={e => setForm(f => ({ ...f, entity_name: e.target.value }))} />
              <Input placeholder="冻结原因" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} />
            </div>
            <DialogFooter><Button onClick={freeze} disabled={!form.entity_id || !form.reason}><Lock className="h-4 w-4 mr-1" />确认冻结</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
