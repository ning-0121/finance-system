'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Search, Factory, Download, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { CUSTOMER_RISK_LABELS, CUSTOMER_RISK_COLORS, type SupplierFinancialProfile, type CustomerRiskLevel } from '@/lib/types/agent'
import { toast } from 'sonner'

const demoSuppliers: SupplierFinancialProfile[] = [
  { id: 'sp1', supplier_name: '深圳华锦纺织', avg_payment_term_days: 30, avg_delay_tolerance_days: 7, historical_stop_supply_count: 0, urgency_score: 40, dependency_score: 65, risk_level: 'A', preferred_payment_method: 'bank_transfer', current_outstanding: 36000, next_due_amount: 36000, next_due_date: '2026-04-11' },
  { id: 'sp2', supplier_name: '东莞利达辅料', avg_payment_term_days: 45, avg_delay_tolerance_days: 14, historical_stop_supply_count: 0, urgency_score: 25, dependency_score: 30, risk_level: 'A', preferred_payment_method: 'bank_transfer', current_outstanding: 0, next_due_amount: 0, next_due_date: null },
  { id: 'sp3', supplier_name: '广州顺风物流', avg_payment_term_days: 15, avg_delay_tolerance_days: 3, historical_stop_supply_count: 1, urgency_score: 75, dependency_score: 50, risk_level: 'B', preferred_payment_method: 'bank_transfer', current_outstanding: 24000, next_due_amount: 12000, next_due_date: '2026-04-12' },
  { id: 'sp4', supplier_name: '佛山永兴制衣厂', avg_payment_term_days: 30, avg_delay_tolerance_days: 5, historical_stop_supply_count: 2, urgency_score: 85, dependency_score: 70, risk_level: 'C', preferred_payment_method: 'bank_transfer', current_outstanding: 140000, next_due_amount: 70000, next_due_date: '2026-04-14' },
  { id: 'sp5', supplier_name: '中山鑫达包装', avg_payment_term_days: 60, avg_delay_tolerance_days: 30, historical_stop_supply_count: 0, urgency_score: 15, dependency_score: 20, risk_level: 'A', preferred_payment_method: 'bank_transfer', current_outstanding: 0, next_due_amount: 0, next_due_date: null },
]

export default function SupplierProfilesPage() {
  const [profiles, setProfiles] = useState<SupplierFinancialProfile[]>(demoSuppliers)
  const [search, setSearch] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const { data } = await supabase.from('supplier_financial_profiles').select('*').order('urgency_score', { ascending: false })
        if (data?.length) setProfiles(data as SupplierFinancialProfile[])
      } catch { /* demo */ }
    }
    load()
  }, [])

  const filtered = profiles.filter(p => !search || p.supplier_name.includes(search))

  return (
    <div className="flex flex-col h-full">
      <Header title="供应商财务画像" subtitle="付款习惯 · 断供风险 · 依赖度评估" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">供应商总数</p><p className="text-2xl font-bold">{profiles.length}</p></CardContent></Card>
          <Card className={profiles.some(p => p.historical_stop_supply_count > 0) ? 'border-amber-200' : ''}>
            <CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">有断供记录</p><p className="text-2xl font-bold text-amber-600">{profiles.filter(p => p.historical_stop_supply_count > 0).length}</p></CardContent>
          </Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">总待付</p><p className="text-2xl font-bold">¥{profiles.reduce((s, p) => s + p.current_outstanding, 0).toLocaleString()}</p></CardContent></Card>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="搜索供应商..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>供应商</TableHead>
                  <TableHead className="text-center">风险</TableHead>
                  <TableHead className="text-right">账期</TableHead>
                  <TableHead className="text-right">延迟容忍</TableHead>
                  <TableHead className="text-center">断供次数</TableHead>
                  <TableHead className="text-right">紧迫度</TableHead>
                  <TableHead className="text-right">依赖度</TableHead>
                  <TableHead className="text-right">待付金额</TableHead>
                  <TableHead>下次到期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(p => (
                  <TableRow key={p.id} className={p.urgency_score > 70 ? 'bg-amber-50/50' : ''}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {p.supplier_name}
                        {p.historical_stop_supply_count > 0 && <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge className={`${CUSTOMER_RISK_COLORS[p.risk_level as CustomerRiskLevel]} border-0`}>{p.risk_level}</Badge>
                    </TableCell>
                    <TableCell className="text-right">{p.avg_payment_term_days}天</TableCell>
                    <TableCell className={`text-right ${p.avg_delay_tolerance_days < 5 ? 'text-red-600' : ''}`}>{p.avg_delay_tolerance_days}天</TableCell>
                    <TableCell className={`text-center ${p.historical_stop_supply_count > 0 ? 'text-red-600 font-semibold' : ''}`}>{p.historical_stop_supply_count}</TableCell>
                    <TableCell className="text-right">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        p.urgency_score > 70 ? 'bg-red-100 text-red-700' : p.urgency_score > 40 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                      }`}>{p.urgency_score}</span>
                    </TableCell>
                    <TableCell className={`text-right ${p.dependency_score > 60 ? 'text-amber-600 font-semibold' : ''}`}>{p.dependency_score}%</TableCell>
                    <TableCell className="text-right font-semibold">¥{p.current_outstanding.toLocaleString()}</TableCell>
                    <TableCell className="text-sm">{p.next_due_date || '-'}</TableCell>
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
