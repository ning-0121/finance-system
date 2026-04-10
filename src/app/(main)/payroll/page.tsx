'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Users } from 'lucide-react'

export default function PayrollPage() {
  return (
    <div className="flex flex-col h-full">
      <Header title="员工薪酬管理" subtitle="工资核算 · 发放记录" />
      <div className="flex-1 flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <Users className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">即将上线</h3>
            <p className="text-sm text-muted-foreground">
              员工薪酬管理模块正在开发中，将支持工资核算、社保公积金、个税计算、发放记录等功能。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
