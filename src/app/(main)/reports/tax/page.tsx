'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Download, FileText } from 'lucide-react'
import { toast } from 'sonner'

const demoTaxRefunds = [
  { orderNo: 'BO-202604-0001', customer: 'Global Trading Inc.', exportAmount: 58500, refundRate: 13, refundAmount: 7605, status: '已申报', appliedDate: '2026-04-15' },
  { orderNo: 'BO-202603-0005', customer: 'Global Trading Inc.', exportAmount: 13500, refundRate: 13, refundAmount: 1755, status: '已到账', appliedDate: '2026-03-25' },
  { orderNo: 'BO-202604-0002', customer: 'Euro Imports GmbH', exportAmount: 60000, refundRate: 13, refundAmount: 7800, status: '待申报', appliedDate: '' },
]

export default function TaxReportPage() {
  const total = demoTaxRefunds.reduce((s, t) => s + t.refundAmount, 0)
  const received = demoTaxRefunds.filter(t => t.status === '已到账').reduce((s, t) => s + t.refundAmount, 0)

  return (
    <div className="flex flex-col h-full">
      <Header title="退税汇总单" subtitle="按订单汇总出口退税金额、申报状态" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">退税总额</p><p className="text-2xl font-bold">${total.toLocaleString()}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">已到账</p><p className="text-2xl font-bold text-green-600">${received.toLocaleString()}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">待到账</p><p className="text-2xl font-bold text-amber-600">${(total - received).toLocaleString()}</p></CardContent></Card>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => toast.success('退税汇总单已导出')}>
            <Download className="h-4 w-4 mr-1" />导出退税单
          </Button>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>订单号</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead className="text-right">出口金额</TableHead>
                  <TableHead className="text-right">退税率</TableHead>
                  <TableHead className="text-right">退税金额</TableHead>
                  <TableHead>申报日期</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {demoTaxRefunds.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-primary font-medium">{t.orderNo}</TableCell>
                    <TableCell>{t.customer}</TableCell>
                    <TableCell className="text-right">${t.exportAmount.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{t.refundRate}%</TableCell>
                    <TableCell className="text-right font-semibold">${t.refundAmount.toLocaleString()}</TableCell>
                    <TableCell>{t.appliedDate || '-'}</TableCell>
                    <TableCell>
                      <Badge variant={t.status === '已到账' ? 'default' : t.status === '已申报' ? 'secondary' : 'outline'}>{t.status}</Badge>
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
