'use client'

// ============================================================
// 采购对账付款 · 逐行核对表(采购订单 ↔ 供应商对账)
// 数据源:payable_records.detail.lines(来自节拍器 payable.created)。
// 差异高亮:供应商对账金额/数量 与 采购订单 不一致 → 红色标出,提示财务人工确认。
// 无 lines(手工应付)→ 返回 null,不显示。
// ============================================================
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AlertTriangle } from 'lucide-react'
import type { PayableDetail } from '@/lib/types'

const n = (v: number | null | undefined) => (v == null ? null : Number(v))
const money = (v: number | null | undefined) => (v == null ? '—' : `¥${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
const qty = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }))
// 差异容差(避免浮点/四舍五入误报)
const diff = (a: number | null, b: number | null) => a != null && b != null && Math.abs(a - b) > 0.01

export function PayableReconcileLines({ detail }: { detail?: PayableDetail | null }) {
  const lines = detail?.lines || []
  if (!lines.length) return null

  let anyDiff = false
  const rows = lines.map(l => {
    const poAmt = n(l.po_amount), supAmt = n(l.supplier_amount)
    const ordQty = n(l.ordered_qty), supQty = n(l.supplier_qty)
    const amtDiff = diff(supAmt, poAmt)
    const qtyDiff = diff(supQty, ordQty)
    if (amtDiff || qtyDiff) anyDiff = true
    return { l, poAmt, supAmt, ordQty, supQty, amtDiff, qtyDiff }
  })

  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <p className="text-xs font-semibold">采购订单 ↔ 供应商对账 · 逐行核对</p>
        {anyDiff && (
          <span className="inline-flex items-center gap-1 text-[11px] text-red-600 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />有差异,请人工确认
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">物料</TableHead>
              <TableHead className="text-xs">规格</TableHead>
              <TableHead className="text-xs text-right">采购数量</TableHead>
              <TableHead className="text-xs text-right">单价</TableHead>
              <TableHead className="text-xs text-right">采购金额</TableHead>
              <TableHead className="text-xs text-right">对账数量</TableHead>
              <TableHead className="text-xs text-right">对账金额</TableHead>
              <TableHead className="text-xs text-right">净应付</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="text-sm">{r.l.material_name || '—'}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.l.specification || '—'}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{qty(r.ordQty)}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{money(n(r.l.unit_price))}</TableCell>
                <TableCell className="text-right text-sm tabular-nums">{money(r.poAmt)}</TableCell>
                <TableCell className={`text-right text-sm tabular-nums ${r.qtyDiff ? 'text-red-600 font-semibold' : ''}`}>{qty(r.supQty)}</TableCell>
                <TableCell className={`text-right text-sm tabular-nums ${r.amtDiff ? 'text-red-600 font-semibold' : ''}`}>{money(r.supAmt)}</TableCell>
                <TableCell className="text-right text-sm tabular-nums font-medium">{money(n(r.l.net_amount))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="px-3 py-1.5 text-[10px] text-muted-foreground border-t">
        供应商对账列为空=采购未录对账数(显示「—」)。红色=对账与采购订单不一致,付款前请核对。
      </p>
    </div>
  )
}
