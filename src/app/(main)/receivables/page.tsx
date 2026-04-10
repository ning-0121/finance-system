'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { CreditCard } from 'lucide-react'

export default function ReceivablesPage() {
  return (
    <div className="flex flex-col h-full">
      <Header title="应收应付管理" subtitle="客户对账 · 账龄追踪" />
      <div className="flex-1 flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <CreditCard className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">即将上线</h3>
            <p className="text-sm text-muted-foreground">
              应收应付管理模块正在开发中，将支持客户对账、账龄分析、回款提醒等功能。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
