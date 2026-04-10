'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { FileText } from 'lucide-react'

export default function CustomsPage() {
  return (
    <div className="flex flex-col h-full">
      <Header title="报关资料管理" subtitle="单据归档 · 状态追踪" />
      <div className="flex-1 flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">即将上线</h3>
            <p className="text-sm text-muted-foreground">
              报关资料管理模块正在开发中，将支持报关单据归档、状态追踪、退税管理等功能。
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
