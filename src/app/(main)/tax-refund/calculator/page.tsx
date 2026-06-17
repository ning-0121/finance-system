'use client'

// ============================================================
// 出口退税净收益测算器（规划工具，纯前端计算，不入库）
// 退税率统一；票点每类自填；除加工费外可开 13% 专票，加工费开不出票→退税0。
// 某类净收益 = 采购额 × (退税率 − 票点)（仅可开票的类）；不可开票的类净收益=0。
// ============================================================
import { useState, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Trash2, ArrowLeft } from 'lucide-react'
import Link from 'next/link'

type Row = { id: number; name: string; ratio: number; pointRate: number; canInvoice: boolean }
let _id = 1
const newRow = (name = '', ratio = 0, pointRate = 0, canInvoice = true): Row => ({ id: _id++, name, ratio, pointRate, canInvoice })

const fmt = (n: number) => `¥${Math.round(n).toLocaleString()}`

export default function TaxRefundCalculator() {
  const [exportAmount, setExportAmount] = useState(1000000)  // 出口额（默认 100 万）
  const [refundRate, setRefundRate] = useState(13)           // 退税率 %
  const [rows, setRows] = useState<Row[]>([
    newRow('布料', 40, 6, true),
    newRow('辅料', 0, 0, true),
    newRow('加工费', 0, 0, false),  // 加工费开不出票
    newRow('包装', 0, 0, true),
    newRow('其他', 0, 0, true),
  ])

  const calc = useMemo(() => {
    const detail = rows.map(r => {
      const purchase = exportAmount * (r.ratio / 100)
      const refund = r.canInvoice ? purchase * (refundRate / 100) : 0
      const pointCost = r.canInvoice ? purchase * (r.pointRate / 100) : 0
      const net = refund - pointCost
      return { ...r, purchase, refund, pointCost, net }
    })
    const totalPurchase = detail.reduce((s, d) => s + d.purchase, 0)
    const totalRefund = detail.reduce((s, d) => s + d.refund, 0)
    const totalPoint = detail.reduce((s, d) => s + d.pointCost, 0)
    const totalNet = totalRefund - totalPoint
    const ratioSum = rows.reduce((s, r) => s + r.ratio, 0)
    return { detail, totalPurchase, totalRefund, totalPoint, totalNet, ratioSum }
  }, [rows, exportAmount, refundRate])

  const upd = (id: number, patch: Partial<Row>) => setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r))

  return (
    <div className="flex flex-col h-full">
      <Header title="退税净收益测算器" subtitle="按成本构成逐类算：净收益 = 采购额 ×(退税率 − 票点)，加工费等开不出票的退税为 0" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <Link href="/tax-refund"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />返回退税台账</Button></Link>

        <div className="flex items-end gap-4 flex-wrap">
          <div className="space-y-1"><Label className="text-xs">出口额（CNY）</Label><Input type="number" className="w-[180px]" value={exportAmount} onChange={e => setExportAmount(Number(e.target.value) || 0)} /></div>
          <div className="space-y-1"><Label className="text-xs">出口退税率 %</Label><Input type="number" step="0.01" className="w-[120px]" value={refundRate} onChange={e => setRefundRate(Number(e.target.value) || 0)} /></div>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>成本构成</TableHead>
                <TableHead className="text-right">占出口额 %</TableHead>
                <TableHead className="text-right">票点 %</TableHead>
                <TableHead className="text-center">可开专票</TableHead>
                <TableHead className="text-right">采购额</TableHead>
                <TableHead className="text-right">可退税</TableHead>
                <TableHead className="text-right">票点成本</TableHead>
                <TableHead className="text-right">净收益</TableHead>
                <TableHead></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {calc.detail.map(d => (
                  <TableRow key={d.id}>
                    <TableCell><Input className="h-8 w-[110px]" value={d.name} onChange={e => upd(d.id, { name: e.target.value })} /></TableCell>
                    <TableCell className="text-right"><Input type="number" className="h-8 w-[80px] text-right ml-auto" value={d.ratio || ''} onChange={e => upd(d.id, { ratio: Number(e.target.value) || 0 })} /></TableCell>
                    <TableCell className="text-right">
                      <Input type="number" step="0.01" className="h-8 w-[80px] text-right ml-auto" value={d.pointRate || ''} disabled={!d.canInvoice} onChange={e => upd(d.id, { pointRate: Number(e.target.value) || 0 })} />
                    </TableCell>
                    <TableCell className="text-center"><input type="checkbox" checked={d.canInvoice} onChange={e => upd(d.id, { canInvoice: e.target.checked })} /></TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{fmt(d.purchase)}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-green-600">{d.canInvoice ? fmt(d.refund) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-red-500">{d.canInvoice ? fmt(d.pointCost) : '—'}</TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${d.net < 0 ? 'text-red-600' : 'text-foreground'}`}>{d.canInvoice ? fmt(d.net) : '¥0'}</TableCell>
                    <TableCell><Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400" onClick={() => setRows(rs => rs.filter(r => r.id !== d.id))}><Trash2 className="h-3.5 w-3.5" /></Button></TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/30 font-semibold border-t-2">
                  <TableCell>合计</TableCell>
                  <TableCell className={`text-right ${calc.ratioSum > 100 ? 'text-red-600' : ''}`}>{calc.ratioSum}%</TableCell>
                  <TableCell colSpan={2}></TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(calc.totalPurchase)}</TableCell>
                  <TableCell className="text-right tabular-nums text-green-600">{fmt(calc.totalRefund)}</TableCell>
                  <TableCell className="text-right tabular-nums text-red-500">{fmt(calc.totalPoint)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(calc.totalNet)}</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Button variant="outline" size="sm" onClick={() => setRows(rs => [...rs, newRow()])}><Plus className="h-4 w-4 mr-1" />加一行成本</Button>

        {/* 结论卡 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">毛退税</p><p className="text-xl font-bold text-green-600">{fmt(calc.totalRefund)}</p></CardContent></Card>
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">票点成本</p><p className="text-xl font-bold text-red-500">{fmt(calc.totalPoint)}</p></CardContent></Card>
          <Card className="border-primary/40"><CardContent className="p-3"><p className="text-xs text-muted-foreground">退税净收益</p><p className={`text-2xl font-bold ${calc.totalNet < 0 ? 'text-red-600' : 'text-primary'}`}>{fmt(calc.totalNet)}</p></CardContent></Card>
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">净收益率(占出口额)</p><p className="text-2xl font-bold">{exportAmount > 0 ? (calc.totalNet / exportAmount * 100).toFixed(2) : '0'}%</p></CardContent></Card>
        </div>

        <div className="text-xs text-muted-foreground space-y-1">
          <p>· 净收益 = 采购额 ×(退税率 − 票点)，仅对「可开专票」的成本生效；加工费等开不出票的，退税与票点都为 0。</p>
          <p>· 占比指该成本占出口额的比例；合计占比 = 总采购成本率，{calc.ratioSum <= 100 ? `毛利空间约 ${(100 - calc.ratioSum).toFixed(0)}%` : '已超 100%，请检查占比'}。</p>
          <p>· 若某类票点 ≥ 退税率，该类净收益为负（一退一付倒亏），不如继续买不含税。</p>
        </div>
      </div>
    </div>
  )
}
