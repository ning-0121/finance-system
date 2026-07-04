'use client'

// ============================================================
// 采购单工作台 —— 订单系统 purchase_order.placed 推来的采购单，财务在此
// 收到(系统内、非企微)、核对预算、一键登记为费用或忽略。
// ============================================================

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, PackageCheck, ChevronRight, Ban, Inbox } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

export interface PoForRegister {
  id: string
  po_no: string
  supplier_name: string | null
  total_amount: number | null
  currency: string
  budget_order_id: string | null   // 由 order_refs 解析到的本系统订单
}

interface PoRow extends PoForRegister {
  delivery_date: string | null
  status: string | null
  placed_at: string | null
  order_refs: unknown
  fin_status: string
  orderLabel: string
}

const money = (n: number | null) => (n == null ? '-' : Number(n).toLocaleString())

export function PurchaseOrderInbox({ syncedOrderMap, onRegister, onChanged }: {
  syncedOrderMap: Record<string, string>
  onRegister: (po: PoForRegister) => void
  onChanged?: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<PoRow[]>([])
  const [tab, setTab] = useState<'pending' | 'all'>('pending')

  const load = useCallback(async () => {
    setLoading(true)
    const sb = createClient()
    const { data, error } = await sb.from('fin_purchase_orders')
      .select('id, po_no, supplier_name, total_amount, currency, delivery_date, status, placed_at, order_refs, fin_status')
      .is('deleted_at', null).order('placed_at', { ascending: false, nullsFirst: false }).limit(500)
    if (error) { console.error('[采购单] 加载失败:', error.message); setLoading(false); return }
    // order_refs(QM单号数组) → 本系统 budget_order_id：精确匹配 syncedOrderMap 的反查
    const qmToBoId = new Map<string, string>()
    for (const [boId, label] of Object.entries(syncedOrderMap)) {
      const qm = label.split(' - ')[0].split(' | ').pop()?.trim()  // label 形如 "款号 | QM号 - 客户"
      if (qm) qmToBoId.set(qm, boId)
    }
    setRows((data || []).map(p => {
      const refs = Array.isArray(p.order_refs) ? (p.order_refs as unknown[]).map(String) : []
      let boId: string | null = null
      for (const r of refs) { const hit = qmToBoId.get(String(r).trim()); if (hit) { boId = hit; break } }
      return {
        id: p.id as string, po_no: p.po_no as string, supplier_name: (p.supplier_name as string) || null,
        total_amount: p.total_amount as number | null, currency: (p.currency as string) || 'CNY',
        delivery_date: (p.delivery_date as string) || null, status: (p.status as string) || null,
        placed_at: (p.placed_at as string) || null, order_refs: p.order_refs,
        budget_order_id: boId, fin_status: (p.fin_status as string) || 'pending',
        orderLabel: boId ? (syncedOrderMap[boId] || '') : (refs.join(', ') || ''),
      }
    }))
    setLoading(false)
  }, [syncedOrderMap])

  useEffect(() => { load() }, [load])

  const setStatus = async (id: string, fin_status: 'ignored' | 'pending') => {
    const sb = createClient()
    const { data: u } = await sb.auth.getUser()
    const { data, error } = await sb.from('fin_purchase_orders')
      .update({ fin_status, processed_at: new Date().toISOString(), processed_by: u?.user?.id || null })
      .eq('id', id).select('id')
    if (error) { toast.error(`操作失败：${error.message}`); return }
    if (!data || data.length === 0) { toast.error('无权限或记录不存在'); return }
    toast.success(fin_status === 'ignored' ? '已忽略' : '已恢复待处理')
    load(); onChanged?.()
  }

  const shown = rows.filter(r => tab === 'all' ? true : r.fin_status === 'pending')
  const pendingCount = rows.filter(r => r.fin_status === 'pending').length

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant={tab === 'pending' ? 'default' : 'outline'} onClick={() => setTab('pending')}>待处理 ({pendingCount})</Button>
        <Button size="sm" variant={tab === 'all' ? 'default' : 'outline'} onClick={() => setTab('all')}>全部 ({rows.length})</Button>
        <span className="text-xs text-muted-foreground ml-2">订单系统下采购单后自动到达此处，登记为费用即计入成本归集</span>
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : shown.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Inbox className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>{tab === 'pending' ? '暂无待处理采购单' : '暂无采购单'}</p>
              <p className="text-xs mt-1">采购单由订单系统在下单时推送（purchase_order.placed）。若长期为空，可能订单系统尚未开始推送采购数据。</p>
            </div>
          ) : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>采购单号</TableHead>
                <TableHead>供应商</TableHead>
                <TableHead className="text-right">金额</TableHead>
                <TableHead>关联订单</TableHead>
                <TableHead>交期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-center">操作</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {shown.map(p => (
                  <TableRow key={p.id} className={p.fin_status === 'pending' ? 'bg-amber-50/40' : ''}>
                    <TableCell className="font-medium text-sm">{p.po_no}</TableCell>
                    <TableCell className="text-sm">{p.supplier_name || <span className="text-amber-600">未带供应商名</span>}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{p.currency} {money(p.total_amount)}</TableCell>
                    <TableCell className="text-sm text-primary">{p.orderLabel || <span className="text-muted-foreground">未关联</span>}</TableCell>
                    <TableCell className="text-sm">{p.delivery_date ? String(p.delivery_date).slice(0, 10) : '-'}</TableCell>
                    <TableCell>
                      {p.fin_status === 'pending' && <Badge className="bg-amber-100 text-amber-700 border-0 text-[10px]">待处理</Badge>}
                      {p.fin_status === 'registered' && <Badge className="bg-green-100 text-green-700 border-0 text-[10px]">已登记费用</Badge>}
                      {p.fin_status === 'ignored' && <Badge variant="outline" className="text-[10px]">已忽略</Badge>}
                    </TableCell>
                    <TableCell className="text-center">
                      {p.fin_status === 'pending' ? (
                        <div className="flex items-center justify-center gap-1">
                          <Button size="sm" className="h-7 text-xs" onClick={() => onRegister(p)}><PackageCheck className="h-3.5 w-3.5 mr-1" />登记为费用<ChevronRight className="h-3 w-3" /></Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-muted-foreground" onClick={() => setStatus(p.id, 'ignored')}><Ban className="h-3.5 w-3.5" /></Button>
                        </div>
                      ) : p.fin_status === 'ignored' ? (
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setStatus(p.id, 'pending')}>恢复</Button>
                      ) : <span className="text-xs text-green-600">✓</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
