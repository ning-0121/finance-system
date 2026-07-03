'use client'

// ============================================================
// 票点归集（公司级）— 全部开票票点一处看：合计/按供应商/按月/明细，可导出。
// 票点不计订单成本与毛利（决算/核算单/GL 均已排除），最终用于出口退税核算。
// 数据源：cost_items where cost_type='tax_point'（含关联订单与未关联的公司费用票点）
// ============================================================

import { useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Download, Search, FileText } from 'lucide-react'
import { toast } from 'sonner'

interface CostLike {
  id: string
  budget_order_id: string | null
  cost_type: string
  description: string
  supplier?: string
  amount: number
  currency: string
  exchange_rate: number
  is_paid: boolean
  delivery_date?: string | null
  created_at: string
}

const cnyOf = (c: CostLike) => (Number(c.amount) || 0) * ((c.currency || 'CNY') === 'CNY' ? 1 : (Number(c.exchange_rate) || 1))
const dateOf = (c: CostLike) => (c.delivery_date || c.created_at || '').slice(0, 10)
const money = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function TaxPointOverview({ costItems, syncedOrderMap }: {
  costItems: CostLike[]
  syncedOrderMap: Record<string, string>
}) {
  const [q, setQ] = useState('')

  const rows = useMemo(() => costItems
    .filter(c => c.cost_type === 'tax_point')
    .map(c => ({ ...c, cny: cnyOf(c), date: dateOf(c), orderLabel: c.budget_order_id ? (syncedOrderMap[c.budget_order_id] || '') : '' }))
    .filter(r => {
      const qq = q.trim().toLowerCase()
      return !qq || (r.supplier || '').toLowerCase().includes(qq) || (r.description || '').toLowerCase().includes(qq) || r.orderLabel.toLowerCase().includes(qq)
    })
    .sort((a, b) => b.date.localeCompare(a.date)), [costItems, syncedOrderMap, q])

  const total = rows.reduce((s, r) => s + r.cny, 0)
  const unpaid = rows.filter(r => !r.is_paid).reduce((s, r) => s + r.cny, 0)
  const thisYear = new Date().getFullYear().toString()
  const yearTotal = rows.filter(r => r.date.startsWith(thisYear)).reduce((s, r) => s + r.cny, 0)

  const bySupplier = useMemo(() => {
    const m = new Map<string, { count: number; total: number; unpaid: number }>()
    rows.forEach(r => {
      const k = (r.supplier || '未指定').trim() || '未指定'
      const e = m.get(k) || { count: 0, total: 0, unpaid: 0 }
      e.count++; e.total += r.cny; if (!r.is_paid) e.unpaid += r.cny
      m.set(k, e)
    })
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total)
  }, [rows])

  const byMonth = useMemo(() => {
    const m = new Map<string, number>()
    rows.forEach(r => { const k = r.date.slice(0, 7) || '未知'; m.set(k, (m.get(k) || 0) + r.cny) })
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12)
  }, [rows])

  const exportCsv = () => {
    if (rows.length === 0) { toast.error('暂无票点记录'); return }
    const head = ['日期', '供应商', '说明', '关联订单', '金额(原币)', '币种', '折人民币', '付款状态']
    const lines = rows.map(r => [r.date, r.supplier || '', r.description || '', r.orderLabel, r.amount, r.currency, r.cny.toFixed(2), r.is_paid ? '已付' : '未付'])
    const csv = [
      `票点归集(出口退税核算用),导出日期,${new Date().toISOString().slice(0, 10)}`,
      `合计(¥),${total.toFixed(2)},未付(¥),${unpaid.toFixed(2)}`,
      head.join(','),
      ...lines.map(l => l.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')),
    ].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `票点归集_${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-3">
      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">票点总额(¥)</p><p className="text-xl font-bold mt-1">{money(total)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">{thisYear}年票点(¥)</p><p className="text-xl font-bold mt-1">{money(yearTotal)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">未付票点(¥)</p><p className="text-xl font-bold mt-1 text-amber-600">{money(unpaid)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">笔数 / 供应商</p><p className="text-xl font-bold mt-1">{rows.length} / {bySupplier.length}</p></CardContent></Card>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="搜供应商/说明/订单..." className="pl-8 h-8 w-[240px] text-sm" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <Button size="sm" variant="outline" onClick={exportCsv}><Download className="h-4 w-4 mr-1" />导出(退税核算用)</Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* 按供应商 */}
        <Card className="lg:col-span-2">
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>供应商</TableHead>
                <TableHead className="text-right">笔数</TableHead>
                <TableHead className="text-right">票点合计(¥)</TableHead>
                <TableHead className="text-right">其中未付(¥)</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {bySupplier.length === 0 && <TableRow><TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                  <FileText className="h-10 w-10 mx-auto mb-2 opacity-30" />暂无票点记录——录入费用时类型选「票点(不计成本)」即归集到这里
                </TableCell></TableRow>}
                {bySupplier.map(([name, s]) => (
                  <TableRow key={name}>
                    <TableCell className="font-medium">{name}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.count}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">{money(s.total)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${s.unpaid > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>{money(s.unpaid)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        {/* 按月 */}
        <Card>
          <CardContent className="p-3">
            <p className="text-xs font-medium mb-2">按月汇总(近12个月)</p>
            <div className="space-y-1">
              {byMonth.length === 0 && <p className="text-xs text-muted-foreground py-6 text-center">—</p>}
              {byMonth.map(([m, v]) => (
                <div key={m} className="flex justify-between text-sm"><span className="text-muted-foreground">{m}</span><span className="tabular-nums font-medium">¥{money(v)}</span></div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 明细 */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>日期</TableHead>
              <TableHead>供应商</TableHead>
              <TableHead>说明</TableHead>
              <TableHead>关联订单</TableHead>
              <TableHead className="text-right">折人民币(¥)</TableHead>
              <TableHead>付款</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm">{r.date}</TableCell>
                  <TableCell className="text-sm font-medium">{r.supplier || '-'}</TableCell>
                  <TableCell className="text-sm">{r.description || '-'}</TableCell>
                  <TableCell className="text-sm text-primary">{r.orderLabel || <span className="text-muted-foreground">公司费用(未关联)</span>}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{money(r.cny)}</TableCell>
                  <TableCell><Badge variant={r.is_paid ? 'default' : 'outline'} className="text-[10px]">{r.is_paid ? '已付' : '未付'}</Badge></TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">暂无明细</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-[11px] text-muted-foreground">口径：票点不计入订单预算/决算/毛利/GL成本（已全链路排除），计入应付与供应商对账；本表用于出口退税核算的费用归集。</p>
    </div>
  )
}
