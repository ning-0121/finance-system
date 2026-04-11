'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Download, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { exportCostSummaryReport } from '@/lib/excel/export-professional'

const demoCommissions: { name: string; role: string; orders: number; revenue: number; rate: number; commission: number; currency: string; status: string }[] = []

export default function CommissionReportPage() {
  const total = demoCommissions.reduce((s, c) => s + c.commission, 0)

  return (
    <div className="flex flex-col h-full">
      <Header title="员工提成单" subtitle="按业务员/跟单员自动汇总已确认订单提成" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-50"><UserCheck className="h-5 w-5 text-purple-600" /></div>
            <div>
              <p className="text-sm text-muted-foreground">提成合计</p>
              <p className="text-2xl font-bold">${total.toLocaleString()}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => {
            exportCostSummaryReport(
              demoCommissions.map(c => ({ category: `${c.name}(${c.role})`, count: c.orders, amount: c.commission, currency: c.currency })),
              { start: '2026-04-01', end: '2026-04-30' }
            )
            toast.success('提成单已导出')
          }}>
            <Download className="h-4 w-4 mr-1" />导出提成单
          </Button>
        </div>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>姓名</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead className="text-center">订单数</TableHead>
                  <TableHead className="text-right">订单总额</TableHead>
                  <TableHead className="text-right">提成比例</TableHead>
                  <TableHead className="text-right">提成金额</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {demoCommissions.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>{c.role}</TableCell>
                    <TableCell className="text-center">{c.orders}</TableCell>
                    <TableCell className="text-right">${c.revenue.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{c.rate}%</TableCell>
                    <TableCell className="text-right font-semibold">${c.commission.toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge variant={c.status === '已发放' ? 'default' : c.status === '已确认' ? 'secondary' : 'outline'}>{c.status}</Badge>
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
