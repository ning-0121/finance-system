'use client'

// 产品价格档案(功能1):按款号搜同款历史——客户PO价 / 加工费 / 利润率 + 客户PO号 / 下单日期。
// 只读聚合(price-history.getProductPriceHistory),不改任何金额。

import { useState } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Loader2, Search, Package } from 'lucide-react'
import { toast } from 'sonner'
import { getProductPriceHistory, type ProductPriceResult } from '@/lib/supabase/price-history'

const fmtDate = (v: string | null) => (v ? String(v).slice(0, 10) : '—')
const money = (n: number | null, c = '') =>
  n == null ? '—' : `${c === 'CNY' ? '¥' : c ? c + ' ' : ''}${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`

export default function ProductPricePage() {
  const [kw, setKw] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ProductPriceResult | null>(null)

  const search = async () => {
    const k = kw.trim()
    if (!k) { toast.error('请输入款号'); return }
    setLoading(true)
    try {
      const r = await getProductPriceHistory(k)
      setResult(r)
      if (r.count === 0) toast.info(`没找到款号「${k}」的订单`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '查询失败')
    } finally { setLoading(false) }
  }

  const rows = result?.rows || []
  const withPrice = rows.filter(r => r.poUnitPrice != null)
  const avgPrice = withPrice.length ? withPrice.reduce((s, r) => s + (r.poUnitPrice || 0), 0) / withPrice.length : null
  const withMargin = rows.filter(r => r.margin != null)
  const avgMargin = withMargin.length ? withMargin.reduce((s, r) => s + (r.margin || 0), 0) / withMargin.length : null

  return (
    <div className="flex flex-col h-full">
      <Header title="产品价格档案" subtitle="按款号搜同款历史:客户PO价 / 加工费 / 利润率 + 客户PO号 / 下单日期" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="flex gap-2 max-w-lg">
          <Input placeholder="输入款号(内部款号/工厂号),回车搜索" value={kw}
            onChange={e => setKw(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} />
          <Button onClick={search} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Search className="h-4 w-4 mr-1" />}搜索
          </Button>
        </div>

        {result && result.count > 0 && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">款号「{result.keyword}」订单数</p><p className="text-xl font-bold">{result.count}</p></CardContent></Card>
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">平均客户PO单价</p><p className="text-xl font-bold">{avgPrice != null ? money(Math.round(avgPrice * 100) / 100) : '—'}</p></CardContent></Card>
              <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">平均利润率</p><p className="text-xl font-bold">{avgMargin != null ? `${Math.round(avgMargin * 10) / 10}%` : '—'}</p></CardContent></Card>
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">同款订单明细(按下单日期倒序)</CardTitle>
                <p className="text-xs text-muted-foreground">加工费=该订单 processing 成本合计(折人民币);利润率=订单级 estimated_margin。点订单号可看详情。</p>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>客户</TableHead>
                    <TableHead>客户PO号</TableHead>
                    <TableHead>下单日期</TableHead>
                    <TableHead className="text-right">PO单价</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                    <TableHead className="text-right">加工费(¥)</TableHead>
                    <TableHead className="text-right">利润率</TableHead>
                    <TableHead>订单</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {rows.map(r => (
                      <TableRow key={r.budgetOrderId}>
                        <TableCell className="font-medium">{r.customerName || '—'}</TableCell>
                        <TableCell>{r.poNumber || '—'}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{fmtDate(r.orderDate)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{money(r.poUnitPrice, r.currency)}</TableCell>
                        <TableCell className="text-right">{r.quantity != null ? r.quantity.toLocaleString() : '—'}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{r.processingCny != null ? money(r.processingCny) : '—'}</TableCell>
                        <TableCell className="text-right">{r.margin != null ? `${r.margin}%` : '—'}</TableCell>
                        <TableCell>
                          <a href={`/orders/${r.budgetOrderId}`} target="_blank" rel="noreferrer" className="text-primary hover:underline text-sm">{r.qmOrderNo || '查看'}</a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}

        {result && result.count === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <Package className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">没找到款号「{result.keyword}」的订单(款号需与订单里的内部款号一致)</p>
          </div>
        )}
      </div>
    </div>
  )
}
