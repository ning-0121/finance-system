'use client'

// 供应商应付明细 — 独立页（深链接）；正文复用 SupplierPayableDetail 组件
import { use } from 'react'
import Link from 'next/link'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { SupplierPayableDetail } from '../SupplierPayableDetail'

export default function SupplierPayableDetailPage({ params }: { params: Promise<{ supplier: string }> }) {
  const { supplier } = use(params)
  const supplierName = decodeURIComponent(supplier)

  return (
    <div className="flex flex-col h-full">
      <Header title="供应商应付明细" subtitle={supplierName} />
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 md:px-6 pt-4">
          <Link href="/payables"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />返回应付账款</Button></Link>
        </div>
        <SupplierPayableDetail supplierName={supplierName} />
      </div>
    </div>
  )
}
