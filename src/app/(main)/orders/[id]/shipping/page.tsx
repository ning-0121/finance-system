'use client'

import { use, useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Plus, ArrowLeft, FileText, Ship, Loader2, CheckCircle } from 'lucide-react'
import { toast } from 'sonner'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { SHIPPING_DOC_LABELS, type ShippingDocType, type ShippingDocument } from '@/lib/types'

const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  draft: { label: '草稿', variant: 'outline' },
  submitted: { label: '已提交', variant: 'secondary' },
  completed: { label: '已完成', variant: 'default' },
}

const demoDocs: ShippingDocument[] = []

export default function ShippingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [docs, setDocs] = useState<ShippingDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [saving, setSaving] = useState(false)

  const [formType, setFormType] = useState<ShippingDocType>('pi')
  const [formNo, setFormNo] = useState('')
  const [formAmount, setFormAmount] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const { data } = await supabase
          .from('shipping_documents')
          .select('*')
          .eq('budget_order_id', id)
          .order('created_at')
        if (data?.length) setDocs(data as ShippingDocument[])
        else setDocs(demoDocs.filter(d => d.budget_order_id === id))
      } catch {
        setDocs(demoDocs.filter(d => d.budget_order_id === id))
      }
      setLoading(false)
    }
    load()
  }, [id])

  const handleAdd = async () => {
    if (!formNo) { toast.error('请输入单据号'); return }
    setSaving(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('shipping_documents')
        .insert({
          budget_order_id: id,
          doc_type: formType,
          document_no: formNo,
          total_amount: Number(formAmount) || 0,
          currency: 'USD',
          status: 'draft',
        })
        .select()
        .single()

      if (error) throw error
      setDocs([...docs, data as ShippingDocument])
      toast.success('单据已创建')
    } catch (err) {
      toast.error(`创建失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
    setSaving(false)
    setShowAdd(false)
    setFormNo('')
    setFormAmount('')
  }

  const handleStatusChange = async (docId: string, newStatus: string) => {
    setDocs(docs.map(d => d.id === docId ? { ...d, status: newStatus as ShippingDocument['status'] } : d))
    try {
      const supabase = createClient()
      await supabase.from('shipping_documents').update({ status: newStatus }).eq('id', docId)
    } catch { /* demo */ }
    toast.success(`状态已更新为${statusLabels[newStatus]?.label || newStatus}`)
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="出货单据管理" subtitle="PI · CI · 装箱单 · 报关单 · 退税单" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <Link href={`/orders/${id}`}>
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />返回订单</Button>
          </Link>
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4 mr-1" />新增单据
          </Button>
        </div>

        {/* 单据进度 */}
        <div className="grid grid-cols-5 gap-3">
          {(['pi', 'ci', 'packing_list', 'customs_declaration', 'tax_refund'] as ShippingDocType[]).map(type => {
            const doc = docs.find(d => d.doc_type === type)
            return (
              <Card key={type} className={doc ? doc.status === 'completed' ? 'border-green-200 bg-green-50/30' : 'border-blue-200' : 'border-dashed opacity-60'}>
                <CardContent className="p-3 text-center">
                  <p className="text-xs font-medium">{SHIPPING_DOC_LABELS[type]}</p>
                  {doc ? (
                    <>
                      <Badge variant={statusLabels[doc.status]?.variant || 'outline'} className="mt-1 text-[10px]">
                        {statusLabels[doc.status]?.label}
                      </Badge>
                      <p className="text-[10px] text-muted-foreground mt-1">{doc.document_no}</p>
                    </>
                  ) : (
                    <p className="text-[10px] text-muted-foreground mt-1">未创建</p>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* 单据列表 */}
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-base">单据明细</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : docs.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground"><Ship className="h-10 w-10 mx-auto mb-2 opacity-30" /><p>暂无出货单据</p></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>类型</TableHead>
                    <TableHead>单据号</TableHead>
                    <TableHead className="text-right">金额</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>创建日期</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map(doc => (
                    <TableRow key={doc.id}>
                      <TableCell><Badge variant="outline">{SHIPPING_DOC_LABELS[doc.doc_type]}</Badge></TableCell>
                      <TableCell className="font-mono text-sm">{doc.document_no}</TableCell>
                      <TableCell className="text-right font-medium">{doc.total_amount > 0 ? `${doc.currency} ${doc.total_amount.toLocaleString()}` : '-'}</TableCell>
                      <TableCell><Badge variant={statusLabels[doc.status]?.variant}>{statusLabels[doc.status]?.label}</Badge></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{new Date(doc.created_at).toLocaleDateString('zh-CN')}</TableCell>
                      <TableCell className="text-center">
                        {doc.status === 'draft' && (
                          <Button size="sm" variant="outline" onClick={() => handleStatusChange(doc.id, 'submitted')}>提交</Button>
                        )}
                        {doc.status === 'submitted' && (
                          <Button size="sm" variant="default" onClick={() => handleStatusChange(doc.id, 'completed')}>
                            <CheckCircle className="h-3.5 w-3.5 mr-1" />完成
                          </Button>
                        )}
                        {doc.status === 'completed' && <span className="text-xs text-green-600">✓ 已完成</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 新增单据弹窗 */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader><DialogTitle>新增出货单据</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>单据类型</Label>
              <Select value={formType} onValueChange={v => setFormType((v || 'pi') as ShippingDocType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SHIPPING_DOC_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>单据号 *</Label>
              <Input placeholder="例: PI-202604-001" value={formNo} onChange={e => setFormNo(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>金额</Label>
              <Input type="number" placeholder="0.00" value={formAmount} onChange={e => setFormAmount(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>取消</Button>
            <Button onClick={handleAdd} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
