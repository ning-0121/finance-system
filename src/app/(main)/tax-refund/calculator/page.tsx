'use client'

// ============================================================
// 出口退税净收益测算器（规划工具，纯前端计算，不入库）
// 双比例模型：
//   成本占比 = 真实花的钱（用于成本/毛利）
//   开票占比 = 实际开票额（可调高——把加工费等开不出票的成本"挪"进原辅料专票）
// 退税/票点都基于「开票占比」；加工费不可开票，开票占比锁 0。
// 红线：总开票额不应超过真实采购总成本（超出即虚开发票，税务风险）。
// ============================================================
import { useState, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Trash2, ArrowLeft, AlertTriangle } from 'lucide-react'
import Link from 'next/link'

type Row = { id: number; name: string; costRatio: number; canInvoice: boolean; invoiceRatio: number; pointRate: number }
let _id = 1
const newRow = (name = '', costRatio = 0, canInvoice = true, invoiceRatio = 0, pointRate = 0): Row => ({ id: _id++, name, costRatio, canInvoice, invoiceRatio, pointRate })
const fmt = (n: number) => `¥${Math.round(n).toLocaleString()}`

export default function TaxRefundCalculator() {
  const [exportAmount, setExportAmount] = useState(1000000)
  const [refundRate, setRefundRate] = useState(13)
  const [rows, setRows] = useState<Row[]>([
    newRow('布料', 40, true, 40, 6),
    newRow('辅料', 10, true, 10, 6),
    newRow('加工费', 30, false, 0, 0),   // 加工费：成本占比可填，但开不出票
    newRow('包装', 5, true, 5, 3),
    newRow('其他', 0, true, 0, 0),
  ])

  const c = useMemo(() => {
    const detail = rows.map(r => {
      const purchase = exportAmount * (r.costRatio / 100)            // 真实成本
      const invoiced = r.canInvoice ? exportAmount * (r.invoiceRatio / 100) : 0  // 开票额
      const refund = invoiced * (refundRate / 100)
      const pointCost = invoiced * (r.pointRate / 100)
      const net = refund - pointCost
      return { ...r, purchase, invoiced, refund, pointCost, net }
    })
    const totalCost = detail.reduce((s, d) => s + d.purchase, 0)
    const totalInvoiced = detail.reduce((s, d) => s + d.invoiced, 0)
    const totalRefund = detail.reduce((s, d) => s + d.refund, 0)
    const totalPoint = detail.reduce((s, d) => s + d.pointCost, 0)
    const totalNet = totalRefund - totalPoint
    const costRatioSum = rows.reduce((s, r) => s + r.costRatio, 0)
    const invoiceRatioSum = rows.reduce((s, r) => s + (r.canInvoice ? r.invoiceRatio : 0), 0)
    const noInvoiceCost = detail.filter(d => !d.canInvoice).reduce((s, d) => s + d.purchase, 0)  // 开不出票的成本(待吸收)
    const overInvoiced = totalInvoiced > totalCost + 0.5  // 红线：开票额超过真实总成本
    return { detail, totalCost, totalInvoiced, totalRefund, totalPoint, totalNet, costRatioSum, invoiceRatioSum, noInvoiceCost, overInvoiced }
  }, [rows, exportAmount, refundRate])

  const upd = (id: number, patch: Partial<Row>) => setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r))

  return (
    <div className="flex flex-col h-full">
      <Header title="退税净收益测算器" subtitle="成本占比=真实花钱；开票占比=实际开票(可调高，吸收加工费)。退税按开票额算" />
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
                <TableHead className="text-right">成本占比%</TableHead>
                <TableHead className="text-center">可开专票</TableHead>
                <TableHead className="text-right">开票占比%</TableHead>
                <TableHead className="text-right">票点%</TableHead>
                <TableHead className="text-right">开票额</TableHead>
                <TableHead className="text-right">可退税</TableHead>
                <TableHead className="text-right">票点成本</TableHead>
                <TableHead className="text-right">净收益</TableHead>
                <TableHead></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {c.detail.map(d => (
                  <TableRow key={d.id}>
                    <TableCell><Input className="h-8 w-[100px]" value={d.name} onChange={e => upd(d.id, { name: e.target.value })} /></TableCell>
                    <TableCell className="text-right"><Input type="number" className="h-8 w-[72px] text-right ml-auto" value={d.costRatio || ''} onChange={e => upd(d.id, { costRatio: Number(e.target.value) || 0 })} /></TableCell>
                    <TableCell className="text-center"><input type="checkbox" checked={d.canInvoice} onChange={e => upd(d.id, { canInvoice: e.target.checked, invoiceRatio: e.target.checked ? d.invoiceRatio : 0 })} /></TableCell>
                    <TableCell className="text-right"><Input type="number" className="h-8 w-[72px] text-right ml-auto" value={d.canInvoice ? (d.invoiceRatio || '') : ''} disabled={!d.canInvoice} placeholder={d.canInvoice ? '' : '—'} onChange={e => upd(d.id, { invoiceRatio: Number(e.target.value) || 0 })} /></TableCell>
                    <TableCell className="text-right"><Input type="number" step="0.01" className="h-8 w-[68px] text-right ml-auto" value={d.canInvoice ? (d.pointRate || '') : ''} disabled={!d.canInvoice} onChange={e => upd(d.id, { pointRate: Number(e.target.value) || 0 })} /></TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{d.canInvoice ? fmt(d.invoiced) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-green-600">{d.canInvoice ? fmt(d.refund) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-red-500">{d.canInvoice ? fmt(d.pointCost) : '—'}</TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${d.net < 0 ? 'text-red-600' : ''}`}>{d.canInvoice ? fmt(d.net) : '¥0'}</TableCell>
                    <TableCell><Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400" onClick={() => setRows(rs => rs.filter(r => r.id !== d.id))}><Trash2 className="h-3.5 w-3.5" /></Button></TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/30 font-semibold border-t-2">
                  <TableCell>合计</TableCell>
                  <TableCell className="text-right">{c.costRatioSum}%</TableCell>
                  <TableCell></TableCell>
                  <TableCell className={`text-right ${c.overInvoiced ? 'text-red-600' : ''}`}>{c.invoiceRatioSum}%</TableCell>
                  <TableCell></TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(c.totalInvoiced)}</TableCell>
                  <TableCell className="text-right tabular-nums text-green-600">{fmt(c.totalRefund)}</TableCell>
                  <TableCell className="text-right tabular-nums text-red-500">{fmt(c.totalPoint)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(c.totalNet)}</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Button variant="outline" size="sm" onClick={() => setRows(rs => [...rs, newRow()])}><Plus className="h-4 w-4 mr-1" />加一行成本</Button>

        {c.overInvoiced && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>开票额合计 {fmt(c.totalInvoiced)} 已超过真实采购总成本 {fmt(c.totalCost)}——超出部分没有真实采购对应，属虚开发票，税务风险极高。请把开票占比控制在「真实总成本」以内。</span>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">毛退税</p><p className="text-xl font-bold text-green-600">{fmt(c.totalRefund)}</p></CardContent></Card>
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">票点成本</p><p className="text-xl font-bold text-red-500">{fmt(c.totalPoint)}</p></CardContent></Card>
          <Card className="border-primary/40"><CardContent className="p-3"><p className="text-xs text-muted-foreground">退税净收益</p><p className={`text-2xl font-bold ${c.totalNet < 0 ? 'text-red-600' : 'text-primary'}`}>{fmt(c.totalNet)}</p></CardContent></Card>
          <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">净收益率(占出口额)</p><p className="text-2xl font-bold">{exportAmount > 0 ? (c.totalNet / exportAmount * 100).toFixed(2) : '0'}%</p></CardContent></Card>
        </div>

        {/* 加工费吸收提示 */}
        <Card className="bg-muted/20">
          <CardContent className="p-3 text-sm space-y-1">
            <p>· <b>真实采购成本率</b> {c.costRatioSum}%（毛利空间约 {(100 - c.costRatioSum).toFixed(0)}%）；<b>已开票率</b> {c.invoiceRatioSum}%。</p>
            <p>· <b>开不出票的成本</b>（加工费等）{fmt(c.noInvoiceCost)}：这块本身退税为 0；可通过调高原辅料「开票占比」把它吸收进 13% 专票——每吸收 1 万、按 6 点票点算净赚约 700 元（13%−6%）。</p>
            <p>· <b>红线</b>：开票额合计不得超过真实采购总成本 {fmt(c.totalCost)}，否则即虚开发票。系统超限会红字提示。</p>
            <p>· 某类票点 ≥ 退税率时该行净收益为负（一退一付倒亏），不如不开票。</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
