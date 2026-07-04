'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Download, UserCheck, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { getCommissionReport } from '@/lib/supabase/queries-v2'

type Row = { invoice_no: string; supplier: string; orderNo: string; amount: number; currency: string; status: string; date: string }
const money = (n: number) => (Number(n) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const STATUS_LABEL: Record<string, string> = { pending: '待付', approved: '已审', paid: '已付', disputed: '争议' }

export default function CommissionReportPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getCommissionReport().then(data => {
      setRows((data || []).map(d => ({
        invoice_no: String(d.invoice_no || ''),
        supplier: String(d.supplier_name || '未指定'),
        orderNo: String((d.budget_orders as { order_no?: string } | null)?.order_no || ''),
        amount: Number(d.total_amount) || 0,
        currency: String(d.currency || 'CNY'),
        status: String(d.status || 'pending'),
        date: String(d.invoice_date || '').slice(0, 10),
      })))
      setLoading(false)
    })
  }, [])

  const total = rows.reduce((s, c) => s + c.amount * ((c.currency || 'CNY') === 'CNY' ? 1 : 7), 0)

  const exportCsv = () => {
    if (rows.length === 0) { toast.error('暂无提成/佣金账单可导出'); return }
    const head = ['佣金账单号', '对象', '关联订单', '金额', '币种', '状态', '日期']
    const lines = rows.map(r => [r.invoice_no, r.supplier, r.orderNo, r.amount, r.currency, STATUS_LABEL[r.status] || r.status, r.date])
    const csv = ['﻿' + head.join(','), ...lines.map(l => l.map(x => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const a = document.createElement('a'); a.href = url; a.download = `提成佣金_${new Date().toISOString().slice(0, 10)}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="提成 / 佣金单" subtitle="按佣金账单汇总（数据来自 actual_invoices 的佣金类发票）" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-50"><UserCheck className="h-5 w-5 text-purple-600" /></div>
            <div>
              <p className="text-sm text-muted-foreground">佣金合计（折人民币）</p>
              <p className="text-2xl font-bold">¥{money(total)}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv}><Download className="h-4 w-4 mr-1" />导出</Button>
        </div>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>佣金账单号</TableHead>
                    <TableHead>对象</TableHead>
                    <TableHead>关联订单</TableHead>
                    <TableHead className="text-right">金额</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>日期</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-14 text-muted-foreground">暂无佣金账单</TableCell></TableRow>}
                  {rows.map((c, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-medium">{c.invoice_no || '-'}</TableCell>
                      <TableCell>{c.supplier}</TableCell>
                      <TableCell className="text-primary">{c.orderNo || '-'}</TableCell>
                      <TableCell className="text-right font-semibold">{c.currency} {money(c.amount)}</TableCell>
                      <TableCell><Badge variant={c.status === 'paid' ? 'default' : c.status === 'approved' ? 'secondary' : 'outline'}>{STATUS_LABEL[c.status] || c.status}</Badge></TableCell>
                      <TableCell>{c.date || '-'}</TableCell>
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
