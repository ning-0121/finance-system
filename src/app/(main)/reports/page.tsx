'use client'

import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import Link from 'next/link'
import { Factory, Users, UserCheck, FileText, ArrowRight } from 'lucide-react'

const reports = [
  {
    title: '供应商对账单',
    description: '按供应商自动汇总所有订单的采购/加工费用，支持按时间/供应商筛选',
    href: '/reports/supplier',
    icon: Factory,
    color: 'bg-blue-50 text-blue-600',
  },
  {
    title: '客户对账单',
    description: '按客户汇总订单收入、回款、账龄，生成客户维度对账',
    href: '/receivables',
    icon: Users,
    color: 'bg-green-50 text-green-600',
  },
  {
    title: '员工提成单',
    description: '按业务员/跟单员自动汇总已确认订单的提成金额',
    href: '/reports/commission',
    icon: UserCheck,
    color: 'bg-purple-50 text-purple-600',
  },
  {
    title: '退税汇总单',
    description: '按订单汇总出口退税金额、申报状态、到账情况',
    href: '/reports/tax',
    icon: FileText,
    color: 'bg-amber-50 text-amber-600',
  },
]

export default function ReportsPage() {
  return (
    <div className="flex flex-col h-full">
      <Header title="汇总报表" subtitle="系统数据自动汇总 · 按条件筛选 · 一键导出" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {reports.map(r => (
            <Link key={r.href} href={r.href}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                <CardContent className="p-6 flex items-start gap-4">
                  <div className={`p-3 rounded-xl ${r.color} shrink-0`}>
                    <r.icon className="h-6 w-6" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold mb-1">{r.title}</h3>
                    <p className="text-sm text-muted-foreground">{r.description}</p>
                  </div>
                  <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0 mt-1" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            <p className="text-sm">所有报表数据来自系统中已录入的订单、发票、费用记录</p>
            <p className="text-sm mt-1">无需重复录入 — 系统自动汇总、过滤、合并生成</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
