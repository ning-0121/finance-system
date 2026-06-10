'use client'

import { useState, useEffect, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Search, Loader2, Plus, Pencil, Trash2, Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { getSuppliers, upsertSupplier, deleteSupplier } from '@/lib/supabase/queries-v2'
import { uploadAttachment, openAttachment, attachmentName } from '@/lib/supabase/storage'
import { normalizeSupplierName } from '@/lib/utils'
import type { Supplier } from '@/lib/types'

type SupplierSummary = { name: string; invoiceCount: number; totalAmount: number; costTypes: string[]; lastDate: string }
const emptyForm = (): Partial<Supplier> => ({ name: '', account_no: '', account_name: '', bank_name: '', contact: '', phone: '', attachment_url: '', notes: '' })

export default function SupplierProfilesPage() {
  const [masters, setMasters] = useState<Supplier[]>([])
  const [summaries, setSummaries] = useState<SupplierSummary[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [form, setForm] = useState<Partial<Supplier>>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [uploadingAtt, setUploadingAtt] = useState(false)

  const handleAttUpload = async (file: File | undefined) => {
    if (!file) return
    setUploadingAtt(true)
    const { path, error } = await uploadAttachment(file, 'suppliers')
    setUploadingAtt(false)
    if (error) { toast.error(error); return }
    setForm(f => ({ ...f, attachment_url: path }))
    toast.success('附件已上传')
  }

  async function reloadMasters() {
    setMasters(await getSuppliers())
  }

  useEffect(() => {
    async function load() {
      try {
        const [mastersData, costRes] = await Promise.all([
          getSuppliers(),
          createClient().from('cost_items').select('supplier, cost_type, amount, created_at').is('deleted_at', null).order('created_at', { ascending: false }),
        ])
        setMasters(mastersData)
        const costs = costRes.data || []
        if (costs.length) {
          const map = new Map<string, { items: typeof costs }>()
          for (const c of costs) {
            const name = normalizeSupplierName(c.supplier as string) || '未指定'
            if (!map.has(name)) map.set(name, { items: [] })
            map.get(name)!.items.push(c)
          }
          setSummaries(Array.from(map.entries()).map(([name, { items }]) => ({
            name,
            invoiceCount: items.length,
            totalAmount: Math.round(items.reduce((s, i) => s + (Number(i.amount) || 0), 0)),
            costTypes: [...new Set(items.map(i => i.cost_type as string).filter(Boolean))],
            lastDate: items[0]?.created_at ? new Date(items[0].created_at as string).toLocaleDateString('zh-CN') : '-',
          })).sort((a, b) => b.totalAmount - a.totalAmount))
        }
      } catch { /* empty */ }
      setLoading(false)
    }
    load()
  }, [])

  // 已聚合但未建档的供应商（提示建档）
  const masterNames = useMemo(() => new Set(masters.map(m => normalizeSupplierName(m.name))), [masters])
  const unregistered = useMemo(
    () => summaries.filter(s => s.name !== '未指定' && !masterNames.has(s.name)),
    [summaries, masterNames],
  )

  const filteredMasters = masters.filter(m => !search || m.name.toLowerCase().includes(search.toLowerCase()))

  const openNew = (prefillName?: string) => { setForm({ ...emptyForm(), name: prefillName || '' }); setDialogOpen(true) }
  const openEdit = (s: Supplier) => { setForm({ ...s }); setDialogOpen(true) }

  const handleSave = async () => {
    if (!form.name?.trim()) { toast.error('请填写供应商名称'); return }
    setSaving(true)
    const { error } = await upsertSupplier(form as Partial<Supplier> & { name: string })
    setSaving(false)
    if (error) { toast.error(error); return }
    toast.success(form.id ? '已更新' : '已建档')
    setDialogOpen(false)
    await reloadMasters()
  }

  const handleDelete = async (s: Supplier) => {
    if (!confirm(`确认删除供应商档案「${s.name}」？（不影响已有费用/付款记录）`)) return
    const { error } = await deleteSupplier(s.id)
    if (error) { toast.error(error); return }
    toast.success('已删除')
    await reloadMasters()
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="供应商信息库" subtitle="供应商档案（账号/户名/开户行/联系方式）· 录入付款时自动带出，避免输错" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">已建档供应商</p><p className="text-2xl font-bold">{masters.length}</p></CardContent></Card>
          <Card className={unregistered.length > 0 ? 'border-amber-200' : ''}><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">待建档（有费用未建档）</p><p className={`text-2xl font-bold ${unregistered.length > 0 ? 'text-amber-600' : ''}`}>{unregistered.length}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">费用聚合供应商</p><p className="text-2xl font-bold">{summaries.length}</p></CardContent></Card>
        </div>

        <Tabs defaultValue="master">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <TabsList>
              <TabsTrigger value="master">供应商档案 ({masters.length})</TabsTrigger>
              <TabsTrigger value="todo">待建档 ({unregistered.length})</TabsTrigger>
              <TabsTrigger value="profile">费用画像 ({summaries.length})</TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="搜索供应商..." className="pl-9 h-9 w-[200px]" value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <Button size="sm" onClick={() => openNew()}><Plus className="h-4 w-4 mr-1" />新建供应商</Button>
            </div>
          </div>

          {/* 供应商档案 */}
          <TabsContent value="master" className="mt-4">
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>供应商名称</TableHead>
                      <TableHead>账号</TableHead>
                      <TableHead>户名</TableHead>
                      <TableHead>开户行</TableHead>
                      <TableHead>联系人</TableHead>
                      <TableHead>电话</TableHead>
                      <TableHead>备注</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredMasters.map(s => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell className="text-sm tabular-nums">{s.account_no || '—'}</TableCell>
                        <TableCell className="text-sm">{s.account_name || '—'}</TableCell>
                        <TableCell className="text-sm">{s.bank_name || '—'}</TableCell>
                        <TableCell className="text-sm">{s.contact || '—'}</TableCell>
                        <TableCell className="text-sm">{s.phone || '—'}</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">{s.notes || '—'}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(s)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => handleDelete(s)}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {filteredMasters.length === 0 && (
                      <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">还没有供应商档案，点「新建供应商」或到「待建档」一键建档</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* 待建档 */}
          <TabsContent value="todo" className="mt-4">
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>供应商（来自费用归集）</TableHead>
                      <TableHead className="text-right">费用笔数</TableHead>
                      <TableHead className="text-right">累计金额(¥)</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unregistered.map(s => (
                      <TableRow key={s.name}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell className="text-right">{s.invoiceCount}</TableCell>
                        <TableCell className="text-right font-semibold">¥ {s.totalAmount.toLocaleString()}</TableCell>
                        <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => openNew(s.name)}><Building2 className="h-3.5 w-3.5 mr-1" />建档</Button></TableCell>
                      </TableRow>
                    ))}
                    {unregistered.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="text-center py-12 text-muted-foreground">所有有费用的供应商都已建档 🎉</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* 费用画像 */}
          <TabsContent value="profile" className="mt-4">
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>供应商</TableHead>
                      <TableHead className="text-right">费用笔数</TableHead>
                      <TableHead className="text-right">总金额(CNY)</TableHead>
                      <TableHead>费用类型</TableHead>
                      <TableHead>最近记录</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summaries.filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase())).map(s => (
                      <TableRow key={s.name}>
                        <TableCell className="font-medium">{s.name}{masterNames.has(s.name) && <Badge className="ml-2 bg-green-100 text-green-700 text-[10px]">已建档</Badge>}</TableCell>
                        <TableCell className="text-right">{s.invoiceCount}</TableCell>
                        <TableCell className="text-right font-semibold">¥ {s.totalAmount.toLocaleString()}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{s.costTypes.join('、') || '-'}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{s.lastDate}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* 新建/编辑供应商档案 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{form.id ? '编辑供应商档案' : '新建供应商档案'}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5"><Label>供应商名称 *</Label><Input value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="如：华航布行" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>银行账号</Label><Input value={form.account_no || ''} onChange={e => setForm(f => ({ ...f, account_no: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label>户名</Label><Input value={form.account_name || ''} onChange={e => setForm(f => ({ ...f, account_name: e.target.value }))} /></div>
            </div>
            <div className="space-y-1.5"><Label>开户行</Label><Input value={form.bank_name || ''} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} placeholder="如：中国银行义乌分行" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>联系人</Label><Input value={form.contact || ''} onChange={e => setForm(f => ({ ...f, contact: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label>电话</Label><Input value={form.phone || ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
            </div>
            <div className="space-y-1.5">
              <Label>附件（营业执照/开户许可证等）</Label>
              {form.attachment_url ? (
                <div className="flex items-center gap-2 text-sm">
                  <button type="button" className="text-primary underline truncate max-w-[220px]" onClick={() => openAttachment(form.attachment_url)}>{attachmentName(form.attachment_url)}</button>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-red-500" onClick={() => setForm(f => ({ ...f, attachment_url: null }))}>移除</Button>
                </div>
              ) : (
                <Input type="file" disabled={uploadingAtt} onChange={e => handleAttUpload(e.target.files?.[0])} className="text-xs" />
              )}
              {uploadingAtt && <p className="text-[11px] text-muted-foreground">上传中…</p>}
            </div>
            <div className="space-y-1.5"><Label>备注</Label><Textarea rows={2} value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}{form.id ? '保存' : '建档'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
