'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { CheckSquare } from 'lucide-react'

export default function PaymentsPage() {
  return (
    <div className="flex flex-col h-full">
      <Header title="付款审批与出纳" subtitle="审批流 · 付款执行" />
      <div className="flex-1 flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <CheckSquare className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">即将上线</h3>
            <p className="text-sm text-muted-foreground">
              付款审批与出纳模块正在开发中，将支持多级审批流、付款执行、银行对账等功能。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
