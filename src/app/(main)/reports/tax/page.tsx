'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getTaxRefunds, type TaxRefund } from '@/lib/supabase/tax-refund'

const STATUS_LABEL: Record<string, string> = { pending: '待申报', declared: '已申报', refunded: '已到账' }
const money = (n: number | null | undefined) => (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function TaxReportPage() {
  const [rows, setRows] = useState<TaxRefund[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { getTaxRefunds().then(r => { setRows(r); setLoading(false) }) }, [])

  const total = rows.reduce((s, t) => s + (Number(t.refundable_amount) || 0), 0)
  const received = rows.filter(t => t.status === 'refunded').reduce((s, t) => s + (Number(t.refund_received_amount ?? t.refundable_amount) || 0), 0)

  const exportCsv = () => {
    if (rows.length === 0) { toast.error('暂无退税记录可导出'); return }
    const head = ['报关单号', '品名', '出口日期', 'FOB(¥)', '进项(¥)', '退税率%', '应退(¥)', '状态', '申报日', '到账日', '到账额(¥)']
    const lines = rows.map(t => [
      t.customs_no || '', t.product_name || '', t.export_date || '', money(t.fob_cny), money(t.input_invoice_amount),
      t.refund_rate ?? '', money(t.refundable_amount), STATUS_LABEL[t.status] || t.status,
      (t.declared_at || '').slice(0, 10), (t.refund_received_at || '').slice(0, 10), money(t.refund_received_amount),
    ])
    const csv = ['﻿' + head.join(','), ...lines.map(l => l.map(x => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const a = document.createElement('a'); a.href = url; a.download = `退税汇总_${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="退税汇总单" subtitle="按报关单汇总出口退税金额、申报与到账状态（数据来自出口退税模块）" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">应退税总额</p><p className="text-2xl font-bold">¥{money(total)}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">已到账</p><p className="text-2xl font-bold text-green-600">¥{money(received)}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">待到账</p><p className="text-2xl font-bold text-amber-600">¥{money(total - received)}</p></CardContent></Card>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={exportCsv}><Download className="h-4 w-4 mr-1" />导出退税单</Button>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>报关单号</TableHead>
                    <TableHead>品名</TableHead>
                    <TableHead className="text-right">FOB(¥)</TableHead>
                    <TableHead className="text-right">退税率</TableHead>
                    <TableHead className="text-right">应退(¥)</TableHead>
                    <TableHead>出口日期</TableHead>
                    <TableHead>状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-14 text-muted-foreground">暂无退税记录——请到「出口退税」模块登记</TableCell></TableRow>}
                  {rows.map(t => (
                    <TableRow key={t.id}>
                      <TableCell className="text-primary font-medium">{t.customs_no || '-'}</TableCell>
                      <TableCell>{t.product_name || '-'}</TableCell>
                      <TableCell className="text-right">¥{money(t.fob_cny)}</TableCell>
                      <TableCell className="text-right">{t.refund_rate ?? '-'}%</TableCell>
                      <TableCell className="text-right font-semibold">¥{money(t.refundable_amount)}</TableCell>
                      <TableCell>{t.export_date || '-'}</TableCell>
                      <TableCell><Badge variant={t.status === 'refunded' ? 'default' : t.status === 'declared' ? 'secondary' : 'outline'}>{STATUS_LABEL[t.status] || t.status}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
