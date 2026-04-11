'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Search, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type SupplierSummary = {
  name: string
  invoiceCount: number
  totalAmount: number
  costTypes: string[]
  lastDate: string
}

export default function SupplierProfilesPage() {
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const { data: costs } = await supabase
          .from('cost_items')
          .select('supplier, cost_type, amount, created_at')
          .order('created_at', { ascending: false })

        if (costs?.length) {
          const map = new Map<string, { items: typeof costs }>()
          for (const c of costs) {
            const name = (c.supplier as string) || '未指定'
            if (!map.has(name)) map.set(name, { items: [] })
            map.get(name)!.items.push(c)
          }
          const summaries: SupplierSummary[] = Array.from(map.entries()).map(([name, { items }]) => ({
            name,
            invoiceCount: items.length,
            totalAmount: Math.round(items.reduce((s, i) => s + (i.amount as number || 0), 0)),
            costTypes: [...new Set(items.map(i => i.cost_type as string).filter(Boolean))],
            lastDate: items[0]?.created_at ? new Date(items[0].created_at as string).toLocaleDateString('zh-CN') : '-',
          })).sort((a, b) => b.totalAmount - a.totalAmount)
          setSuppliers(summaries)
        }
      } catch { /* empty */ }
      setLoading(false)
    }
    load()
  }, [])

  const filtered = suppliers.filter(s => !search || s.name.toLowerCase().includes(search.toLowerCase()))
  const totalAmount = suppliers.reduce((s, c) => s + c.totalAmount, 0)

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="供应商画像" subtitle="基于费用记录聚合 · 付款金额排名" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="grid grid-cols-3 gap-4">
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">供应商总数</p><p className="text-2xl font-bold">{suppliers.length}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">费用记录数</p><p className="text-2xl font-bold">{suppliers.reduce((s, c) => s + c.invoiceCount, 0)}</p></CardContent></Card>
          <Card><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground">总付款金额</p><p className="text-2xl font-bold">¥ {totalAmount.toLocaleString()}</p></CardContent></Card>
        </div>

        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="搜索供应商..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>供应商</TableHead>
                  <TableHead className="text-right">费用笔数</TableHead>
                  <TableHead className="text-right">总金额(CNY)</TableHead>
                  <TableHead>费用类型</TableHead>
                  <TableHead>最近记录</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(s => (
                  <TableRow key={s.name}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="text-right">{s.invoiceCount}</TableCell>
                    <TableCell className="text-right font-semibold">¥ {s.totalAmount.toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.costTypes.join('、') || '-'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.lastDate}</TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center py-12 text-muted-foreground">暂无供应商数据，费用录入后自动生成</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
