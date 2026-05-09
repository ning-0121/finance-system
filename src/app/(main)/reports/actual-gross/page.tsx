'use client'

import { useEffect, useState, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Loader2, Download, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { getBudgetOrders } from '@/lib/supabase/queries'
import type { BudgetOrder } from '@/lib/types'
import { toast } from 'sonner'
import Link from 'next/link'

type Row = {
  id: string
  order_no: string
  customer: string
  currency: string
  revenue_orig: number
  received_orig: number
  received_at: string | null
  cost_cny: number
  payable_cny: number
  gross_cny: number
  margin_pct: number
}

function payableToCny(amount: number, currency: string): number {
  const c = (currency || 'CNY').toUpperCase()
  if (c === 'CNY' || c === 'RMB') return amount
  if (c === 'USD') return amount * 7.2
  return amount * 7.2
}

function receivedAmount(o: BudgetOrder): number {
  const explicit = o.ar_received_amount != null && !Number.isNaN(Number(o.ar_received_amount))
  if (explicit) return Math.min(Math.max(0, Number(o.ar_received_amount)), o.total_revenue)
  if (o.status === 'closed') return o.total_revenue
  return 0
}

export default function ActualGrossReportPage() {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<Row[]>([])
  const [search, setSearch] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const orders = await getBudgetOrders()
        const approved = orders.filter(o => o.status === 'approved' || o.status === 'closed')

        const supabase = createClient()
        const [{ data: costs }, { data: payables }] = await Promise.all([
          supabase.from('cost_items').select('budget_order_id, amount, exchange_rate').not('budget_order_id', 'is', null),
          supabase.from('payable_records').select('budget_order_id, amount, currency').not('budget_order_id', 'is', null),
        ])

        const costByOrder = new Map<string, number>()
        costs?.forEach((r: { budget_order_id: string; amount: number; exchange_rate: number }) => {
          const id = r.budget_order_id
          const cny = (Number(r.amount) || 0) * (Number(r.exchange_rate) || 1)
          costByOrder.set(id, (costByOrder.get(id) || 0) + cny)
        })

        const payableByOrder = new Map<string, number>()
        payables?.forEach((r: { budget_order_id: string; amount: number; currency: string }) => {
          const id = r.budget_order_id
          const cny = payableToCny(Number(r.amount) || 0, r.currency || 'CNY')
          payableByOrder.set(id, (payableByOrder.get(id) || 0) + cny)
        })

        const list: Row[] = approved.map(o => {
          const rate = o.exchange_rate || 1
          const revOrig = o.total_revenue || 0
          const recOrig = receivedAmount(o)
          const recCny = recOrig * rate
          const costCny = costByOrder.get(o.id) || 0
          const payCny = payableByOrder.get(o.id) || 0
          const gross = recCny - costCny
          const margin = recCny > 0 ? (gross / recCny) * 100 : 0
          return {
            id: o.id,
            order_no: o.order_no,
            customer: o.customer?.company || '-',
            currency: o.currency || 'USD',
            revenue_orig: revOrig,
            received_orig: recOrig,
            received_at: o.ar_received_at || null,
            cost_cny: Math.round(costCny * 100) / 100,
            payable_cny: Math.round(payCny * 100) / 100,
            gross_cny: Math.round(gross * 100) / 100,
            margin_pct: Math.round(margin * 100) / 100,
          }
        })

        setRows(list.sort((a, b) => b.gross_cny - a.gross_cny))
      } catch (e) {
        console.error(e)
        toast.error('加载失败')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(r => r.order_no.toLowerCase().includes(q) || r.customer.toLowerCase().includes(q))
  }, [rows, search])

  const exportCsv = () => {
    const headers = ['订单号', '客户', '币种', '合同销售额', '实际收款(原币)', '实际收款日', '费用归集(¥)', '应付登记(¥)', '实际毛利(¥)', '毛利率%']
    const lines = filtered.map(r => [
      r.order_no,
      r.customer,
      r.currency,
      r.revenue_orig,
      r.received_orig,
      r.received_at ? r.received_at.slice(0, 10) : '',
      r.cost_cny,
      r.payable_cny,
      r.gross_cny,
      r.margin_pct,
    ].join(','))
    const csv = [headers.join(','), ...lines].join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `订单实际毛利_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('已导出 CSV')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <Header
        title="订单实际毛利表"
        subtitle="以实际收款（或已关闭推断）与费用归集为基础，区别于订单成本核算预算口径"
      />

      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <Card className="border-muted">
          <CardContent className="p-4 text-sm text-muted-foreground space-y-1">
            <p>
              <strong className="text-foreground">实际收款：</strong>
              优先取应收账款中登记的金额与时间；未登记且订单已关闭时，按合同销售额视为全额已收。
            </p>
            <p>
              <strong className="text-foreground">成本：</strong>
              费用归集模块合计（金额×汇率折人民币）。应付登记列为应付账款模块同订单合计（非人民币按约 7.2 折算，便于核对）。
            </p>
            <p>
              <strong className="text-foreground">实际毛利(¥)</strong>
              = 实际收款折人民币 − 费用归集合计；可与右侧应付列交叉核对，不包含应付以免与费用重复记账。
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3 justify-between">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="搜索订单号、客户..."
              className="pl-9"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="h-4 w-4 mr-1" />导出 CSV
          </Button>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>订单号</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead className="text-right">合同销售额</TableHead>
                  <TableHead className="text-right">实际收款</TableHead>
                  <TableHead>收款日</TableHead>
                  <TableHead className="text-right">费用归集(¥)</TableHead>
                  <TableHead className="text-right">应付登记(¥)</TableHead>
                  <TableHead className="text-right">实际毛利(¥)</TableHead>
                  <TableHead className="text-right">毛利率%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(r => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link href={`/orders/${r.id}`} className="text-primary hover:underline text-sm">{r.order_no}</Link>
                    </TableCell>
                    <TableCell className="text-sm">{r.customer}</TableCell>
                    <TableCell className="text-right text-sm">{r.currency} {r.revenue_orig.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm font-medium">{r.currency} {r.received_orig.toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.received_at ? new Date(r.received_at).toLocaleDateString('zh-CN') : '—'}
                    </TableCell>
                    <TableCell className="text-right">¥{r.cost_cny.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-muted-foreground">¥{r.payable_cny.toLocaleString()}</TableCell>
                    <TableCell className={`text-right font-semibold ${r.gross_cny >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      ¥{r.gross_cny.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">{r.margin_pct}%</TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">暂无数据</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
