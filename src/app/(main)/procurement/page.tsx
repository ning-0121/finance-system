'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { ShoppingCart } from 'lucide-react'

export default function ProcurementPage() {
  return (
    <div className="flex flex-col h-full">
      <Header title="采购与工厂管理" subtitle="目标价 · 对账 · 审核" />
      <div className="flex-1 flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <ShoppingCart className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">即将上线</h3>
            <p className="text-sm text-muted-foreground">
              采购与工厂管理模块正在开发中，将支持目标价管理、供应商对账、采购审核等功能。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
