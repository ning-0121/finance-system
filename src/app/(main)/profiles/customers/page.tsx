'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Search, Users, AlertTriangle, TrendingUp, Shield, Download } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { CUSTOMER_RISK_LABELS, CUSTOMER_RISK_COLORS, type CustomerFinancialProfile, type CustomerRiskLevel } from '@/lib/types/agent'
import { toast } from 'sonner'
import { exportCostSummaryReport } from '@/lib/excel/export-professional'

const demoProfiles: CustomerFinancialProfile[] = [
  { id: 'cp1', customer_id: 'cust-1', customer_name: 'Global Trading Inc.', avg_payment_days: 35, overdue_rate: 0.15, average_order_profit_rate: 20.09, deduction_frequency: 1, late_confirmation_frequency: 2, invoice_dispute_frequency: 0, bad_debt_score: 12, dependency_score: 35, total_outstanding: 28500, credit_limit: 500000, risk_level: 'B', last_updated_at: '2026-04-09T10:00:00Z' },
  { id: 'cp2', customer_id: 'cust-2', customer_name: 'Euro Imports GmbH', avg_payment_days: 42, overdue_rate: 0.08, average_order_profit_rate: 11.17, deduction_frequency: 0, late_confirmation_frequency: 1, invoice_dispute_frequency: 0, bad_debt_score: 8, dependency_score: 25, total_outstanding: 60000, credit_limit: 300000, risk_level: 'B', last_updated_at: '2026-04-09T10:00:00Z' },
  { id: 'cp3', customer_id: 'cust-3', customer_name: 'Tokyo Solutions Ltd.', avg_payment_days: 22, overdue_rate: 0, average_order_profit_rate: 24.22, deduction_frequency: 0, late_confirmation_frequency: 0, invoice_dispute_frequency: 0, bad_debt_score: 0, dependency_score: 20, total_outstanding: 0, credit_limit: 50000000, risk_level: 'A', last_updated_at: '2026-04-09T10:00:00Z' },
  { id: 'cp4', customer_id: null, customer_name: 'ABC Trading Co.', avg_payment_days: 55, overdue_rate: 0.45, average_order_profit_rate: 15.5, deduction_frequency: 3, late_confirmation_frequency: 4, invoice_dispute_frequency: 2, bad_debt_score: 42, dependency_score: 15, total_outstanding: 42000, credit_limit: 100000, risk_level: 'C', last_updated_at: '2026-04-07T09:00:00Z' },
  { id: 'cp5', customer_id: null, customer_name: 'MegaCorp International', avg_payment_days: 78, overdue_rate: 0.65, average_order_profit_rate: 18.0, deduction_frequency: 2, late_confirmation_frequency: 5, invoice_dispute_frequency: 3, bad_debt_score: 68, dependency_score: 10, total_outstanding: 45000, credit_limit: 80000, risk_level: 'D', last_updated_at: '2026-04-09T10:00:00Z' },
]

export default function CustomerProfilesPage() {
  const [profiles, setProfiles] = useState<CustomerFinancialProfile[]>(demoProfiles)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const { data } = await supabase.from('customer_financial_profiles').select('*').order('risk_level')
        if (data?.length) setProfiles(data as CustomerFinancialProfile[])
      } catch { /* demo */ }
      setLoading(false)
    }
    load()
  }, [])

  const filtered = profiles.filter(p => !search || p.customer_name.toLowerCase().includes(search.toLowerCase()))
  const riskCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  profiles.forEach(p => { riskCounts[p.risk_level as keyof typeof riskCounts]++ })

  return (
    <div className="flex flex-col h-full">
      <Header title="客户财务画像" subtitle="AI Agent 持续评估 · 付款行为 · 信用风险" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* 风险分布 */}
        <div className="flex gap-2 flex-wrap">
          {(['A','B','C','D','E'] as CustomerRiskLevel[]).map(level => (
            <Card key={level} className="flex-1 min-w-[100px]">
              <CardContent className="p-3 text-center">
                <Badge className={`${CUSTOMER_RISK_COLORS[level]} border-0 mb-1`}>{level}</Badge>
                <p className="text-lg font-bold">{riskCounts[level]}</p>
                <p className="text-[10px] text-muted-foreground">{CUSTOMER_RISK_LABELS[level]}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="搜索客户..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <Button variant="outline" size="sm" onClick={() => {
            exportCostSummaryReport(
              filtered.map(p => ({ category: `${p.customer_name} [${p.risk_level}]`, count: Math.round(p.avg_payment_days), amount: p.total_outstanding, currency: 'USD' })),
              { start: '2026-01-01', end: '2026-04-10' }
            )
            toast.success('客户画像已导出')
          }}>
            <Download className="h-4 w-4 mr-1" />导出
          </Button>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>客户</TableHead>
                  <TableHead className="text-center">风险等级</TableHead>
                  <TableHead className="text-right">平均付款天数</TableHead>
                  <TableHead className="text-right">逾期率</TableHead>
                  <TableHead className="text-right">平均利润率</TableHead>
                  <TableHead className="text-right">未付余额</TableHead>
                  <TableHead className="text-right">信用额度</TableHead>
                  <TableHead className="text-right">坏账评分</TableHead>
                  <TableHead className="text-right">依赖度</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(p => (
                  <TableRow key={p.id} className={p.risk_level === 'D' || p.risk_level === 'E' ? 'bg-red-50/50' : ''}>
                    <TableCell className="font-medium">{p.customer_name}</TableCell>
                    <TableCell className="text-center">
                      <Badge className={`${CUSTOMER_RISK_COLORS[p.risk_level]} border-0`}>
                        {p.risk_level} · {CUSTOMER_RISK_LABELS[p.risk_level]}
                      </Badge>
                    </TableCell>
                    <TableCell className={`text-right ${p.avg_payment_days > 60 ? 'text-red-600 font-semibold' : p.avg_payment_days > 45 ? 'text-amber-600' : ''}`}>
                      {p.avg_payment_days}天
                    </TableCell>
                    <TableCell className={`text-right ${p.overdue_rate > 0.3 ? 'text-red-600 font-semibold' : p.overdue_rate > 0.1 ? 'text-amber-600' : ''}`}>
                      {(p.overdue_rate * 100).toFixed(0)}%
                    </TableCell>
                    <TableCell className={`text-right ${p.average_order_profit_rate < 10 ? 'text-red-600' : p.average_order_profit_rate < 15 ? 'text-amber-600' : 'text-green-600'}`}>
                      {p.average_order_profit_rate}%
                    </TableCell>
                    <TableCell className="text-right font-semibold">${p.total_outstanding.toLocaleString()}</TableCell>
                    <TableCell className="text-right">${p.credit_limit.toLocaleString()}</TableCell>
                    <TableCell className={`text-right ${p.bad_debt_score > 50 ? 'text-red-600 font-semibold' : ''}`}>
                      {p.bad_debt_score}
                    </TableCell>
                    <TableCell className={`text-right ${p.dependency_score > 40 ? 'text-amber-600' : ''}`}>
                      {p.dependency_score}%
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
