'use client'

import { useState } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Search, Download, DollarSign, FileText, Clock } from 'lucide-react'
import { toast } from 'sonner'
import { exportCostSummaryReport } from '@/lib/excel/export-professional'

// 演示数据 — 自动从actual_invoices汇总
const demoSupplierData: { supplier: string; invoices: number; total: number; paid: number; unpaid: number; currency: string; orders: string[] }[] = []

export default function SupplierReportPage() {
  const [search, setSearch] = useState('')

  const filtered = demoSupplierData.filter(s =>
    !search || s.supplier.includes(search)
  )
  const totalAll = filtered.reduce((s, d) => s + d.total, 0)
  const unpaidAll = filtered.reduce((s, d) => s + d.unpaid, 0)

  return (
    <div className="flex flex-col h-full">
      <Header title="供应商对账单" subtitle="按供应商自动汇总所有订单费用 · 支持筛选导出" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* KPI */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50"><FileText className="h-4 w-4 text-blue-600" /></div>
              <div><p className="text-xs text-muted-foreground">供应商数</p><p className="text-xl font-bold">{filtered.length}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-50"><DollarSign className="h-4 w-4 text-green-600" /></div>
              <div><p className="text-xs text-muted-foreground">总金额</p><p className="text-xl font-bold">¥{totalAll.toLocaleString()}</p></div>
            </CardContent>
          </Card>
          <Card className={unpaidAll > 0 ? 'border-amber-200' : ''}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-50"><Clock className="h-4 w-4 text-amber-600" /></div>
              <div><p className="text-xs text-muted-foreground">待付金额</p><p className="text-xl font-bold text-amber-600">¥{unpaidAll.toLocaleString()}</p></div>
            </CardContent>
          </Card>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between gap-4">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="搜索供应商..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" onClick={() => {
            exportCostSummaryReport(
              filtered.map(s => ({ category: s.supplier, count: s.invoices, amount: s.total, currency: s.currency })),
              { start: '2026-01-01', end: '2026-04-09' }
            )
            toast.success('供应商对账单已导出')
          }}>
            <Download className="h-4 w-4 mr-1" />导出对账单
          </Button>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>供应商</TableHead>
                  <TableHead className="text-center">发票数</TableHead>
                  <TableHead className="text-right">总金额</TableHead>
                  <TableHead className="text-right">已付</TableHead>
                  <TableHead className="text-right">待付</TableHead>
                  <TableHead>关联订单</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{s.supplier}</TableCell>
                    <TableCell className="text-center">{s.invoices}</TableCell>
                    <TableCell className="text-right font-semibold">¥{s.total.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-green-600">¥{s.paid.toLocaleString()}</TableCell>
                    <TableCell className={`text-right font-semibold ${s.unpaid > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                      ¥{s.unpaid.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {s.orders.map(o => <Badge key={o} variant="outline" className="text-[10px]">{o}</Badge>)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={s.unpaid === 0 ? 'default' : 'secondary'}>
                        {s.unpaid === 0 ? '已结清' : '有余额'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
