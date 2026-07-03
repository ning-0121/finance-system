'use client'

import { useEffect, useState, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Loader2, Download, Search, FileSpreadsheet, Eye } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { getBudgetOrders, getBudgetOrderById } from '@/lib/supabase/queries'
import type { BudgetOrder } from '@/lib/types'
import {
  buildSettlementBundle,
  exportSettlementInvoiceToExcel,
  exportSettlementInvoicesWorkbook,
  synthesizeExpensesFromBudget,
  type SettlementBundle,
} from '@/lib/excel/export-settlement-invoice'
import { toast } from 'sonner'
import Link from 'next/link'

type Row = {
  id: string
  order_no: string
  internalNo: string
  customer: string
  currency: string
  rate: number
  revenue_orig: number
  revenue_cny: number
  received_orig: number
  received_cny: number
  received_at: string | null
  cost_cny: number
  payable_cny: number
  gross_cny: number
  margin_pct: number
}

function payableToCny(amount: number, currency: string, orderRate?: number): number {
  const c = (currency || 'CNY').toUpperCase()
  if (c === 'CNY' || c === 'RMB') return amount
  // 优先用所属订单的汇率折算；订单缺汇率才回退约定值 7.2（页面有披露）
  return amount * (Number(orderRate) || 7.2)
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
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [viewBundle, setViewBundle] = useState<SettlementBundle | null>(null)

  // 构造某订单的「订单核算单」数据（收/支明细 + 毛利），导出与页面查看共用
  const buildBundleForOrder = async (orderId: string): Promise<SettlementBundle | null> => {
    const order = await getBudgetOrderById(orderId)
    if (!order) { toast.error('订单不存在'); return null }
    const sb = createClient()
    const [{ data: allocs }, { data: receipts }, { data: expenses }, { data: ship }] = await Promise.all([
      // 回款流水（权威「已收」口径，与应收账款页一致）：分配明细 join 回款流水
      sb.from('receivable_payment_allocations')
        .select('amount_cny, receivable_payments(received_at, customer_name, bank_account, payment_reference, currency, exchange_rate)')
        .eq('budget_order_id', orderId).is('voided_at', null)
        .order('created_at', { ascending: true }),
      sb.from('actual_invoices')
        .select('invoice_date, total_amount, currency, exchange_rate, supplier_name, invoice_no')
        .eq('budget_order_id', orderId).eq('invoice_type', 'customer_statement').eq('status', 'paid')
        .is('deleted_at', null).order('invoice_date', { ascending: true }),
      sb.from('cost_items')
        .select('cost_type, description, supplier, cost_group, quantity, unit, unit_price, amount, currency, exchange_rate, delivery_date, created_at')
        .neq('cost_type', 'tax_point')   // 票点不进核算单"支"区
        .eq('budget_order_id', orderId).is('deleted_at', null)
        .order('cost_group, supplier, created_at'),
      sb.from('shipping_documents')
        .select('completed_at, updated_at, status').eq('budget_order_id', orderId)
        .eq('status', 'completed').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    // 收款口径统一：有回款流水 → 流水为准（修复「主页有回款、核算单显示暂无回款」）；
    // 无流水 → 回退发票口径（历史数据兼容）。两者不合并，避免同一笔钱双算。
    const ledgerReceipts = (allocs || []).map(a => {
      const p = (a as Record<string, unknown>).receivable_payments as { received_at?: string; customer_name?: string; bank_account?: string; payment_reference?: string; currency?: string; exchange_rate?: number } | null
      const cny = Number((a as Record<string, unknown>).amount_cny) || 0
      const rate = Number(p?.exchange_rate) || 0
      const isUsd = p?.currency === 'USD' && rate > 0
      return {
        invoice_date: p?.received_at || null,
        // USD 回款按流水汇率反推美金额，保留核算单「美金/汇率」两列；CNY 直收按 1
        total_amount: isUsd ? Math.round((cny / rate) * 100) / 100 : cny,
        currency: isUsd ? 'USD' : 'CNY',
        exchange_rate: isUsd ? rate : 1,
        supplier_name: p?.customer_name || p?.bank_account || null,
        invoice_no: p?.payment_reference || '回款流水',
      }
    })
    let receiptRows = ledgerReceipts.length > 0 ? ledgerReceipts : (receipts || [])
    // 第三层回退：历史「登记收款」只写了 ar_received_amount（无流水/无发票明细）。
    // 合成一行汇总，保证核算单「收」与毛利表主页的实际收款一致，不再显示「暂无回款」。
    if (receiptRows.length === 0 && Number(order.ar_received_amount) > 0) {
      receiptRows = [{
        invoice_date: null,
        total_amount: Number(order.ar_received_amount) || 0,
        currency: order.currency || 'CNY',
        exchange_rate: order.currency === 'CNY' ? 1 : (Number(order.exchange_rate) || 1),
        supplier_name: order.customer?.company || null,
        invoice_no: '历史登记已收（无流水明细）',
      }]
    }
    const productName = (order.items as unknown as Record<string, unknown>[])?.[0]?.product_name as string | undefined
    // 基本信息同步：内部订单号/节拍器号/数量 来自节拍器同步表（与订单详情「基本信息」同口径）
    const { data: syncedRow } = await sb.from('synced_orders')
      .select('style_no, order_no, quantity, quantity_unit')
      .eq('budget_order_id', orderId).limit(1).maybeSingle()
    const orderWithCustomer = {
      ...order,
      product_name: productName || null,
      customer_name: order.customer?.company || '',
      internal_no: (syncedRow?.style_no as string) || '',
      metronome_no: (syncedRow?.order_no as string) || '',
      synced_quantity: syncedRow?.quantity != null ? Number(syncedRow.quantity) : null,
      synced_quantity_unit: (syncedRow?.quantity_unit as string) || null,
    }
    // 支区「时间」列：送货日期优先（财务对账口径），历史数据回退录入时间
    const expWithDate = (expenses || []).map(e => ({ ...e, created_at: (e as Record<string, unknown>).delivery_date as string || e.created_at }))
    const exp = expWithDate.length > 0 ? expWithDate : synthesizeExpensesFromBudget(order)
    return buildSettlementBundle(
      orderWithCustomer as never,
      receiptRows,
      exp as never,
      (ship?.completed_at as string | undefined) || (ship?.updated_at as string | undefined) || null,
    )
  }

  // 下载 Excel
  // 批量导出：当前筛选范围内全部订单 → 一个工作簿一单一 Sheet（替代财务手工维护的核算工作簿）
  const [batchExporting, setBatchExporting] = useState<number | null>(null)
  const exportAllInvoices = async () => {
    if (filtered.length === 0) { toast.error('当前无订单可导出'); return }
    setBatchExporting(0)
    try {
      const bundles: SettlementBundle[] = []
      let estimated = 0
      for (let i = 0; i < filtered.length; i++) {
        setBatchExporting(i + 1)
        try {
          const b = await buildBundleForOrder(filtered[i].id)
          if (b) {
            bundles.push(b)
            if (b.meta.cost_source === 'estimated') estimated++
          }
        } catch (e) {
          console.error('[批量核算单] 跳过', filtered[i].order_no, e)
        }
      }
      if (bundles.length === 0) { toast.error('没有可导出的核算单'); return }
      exportSettlementInvoicesWorkbook(bundles)
      toast.success(`已导出 ${bundles.length} 张核算单(一单一Sheet)${estimated > 0 ? `；其中 ${estimated} 单费用归集无明细,支区为预算估算` : ''}`)
    } finally {
      setBatchExporting(null)
    }
  }

  const exportSettlementInvoice = async (orderId: string) => {
    setExportingId(orderId)
    try {
      const bundle = await buildBundleForOrder(orderId)
      if (!bundle) return
      exportSettlementInvoiceToExcel(bundle)
      const warn = [
        bundle.meta.cost_source === 'estimated' && '⚠ 支区用预算估算（该订单费用归集暂无明细）',
        bundle.meta.receipt_source === 'pending' && '⚠ 暂无实际回款',
      ].filter(Boolean).join(' ')
      toast.success(`核算单 ${bundle.header.order_no} 已导出${warn ? ' (' + warn + ')' : ''}`)
    } catch (e) {
      toast.error(`导出失败: ${e instanceof Error ? e.message : '未知错误'}`)
    } finally {
      setExportingId(null)
    }
  }

  // 页面查看
  const viewSettlementInvoice = async (orderId: string) => {
    setViewingId(orderId)
    try {
      const bundle = await buildBundleForOrder(orderId)
      if (bundle) setViewBundle(bundle)
    } catch (e) {
      toast.error(`加载失败: ${e instanceof Error ? e.message : '未知错误'}`)
    } finally {
      setViewingId(null)
    }
  }

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const orders = await getBudgetOrders()
        const approved = orders.filter(o => o.status === 'approved' || o.status === 'closed')

        const supabase = createClient()
        const approvedIds = approved.map(o => o.id)
        // 分页取全量（防 1000 行静默截断）；汇总必须与明细同口径：排除已软删费用、已作废应付
        const [{ data: costs }, { data: payables }, { data: allocs }] = await Promise.all([
          fetchAll<{ budget_order_id: string; amount: number; currency: string; exchange_rate: number }>((from, to) =>
            supabase.from('cost_items').select('budget_order_id, amount, currency, exchange_rate')
              .not('budget_order_id', 'is', null).is('deleted_at', null)
              .neq('cost_type', 'tax_point')   // 票点不计毛利成本(留作退税核算)
              .order('id', { ascending: true }).range(from, to)),
          fetchAll<{ budget_order_id: string; amount: number; currency: string }>((from, to) =>
            supabase.from('payable_records').select('budget_order_id, amount, currency')
              .not('budget_order_id', 'is', null).neq('payment_status', 'cancelled')
              .order('id', { ascending: true }).range(from, to)),
          // 已收权威口径=回款流水分配合计（与应收页/核算单弹窗同源），避免主表用 ar_received_amount 各算各的
          fetchAll<{ budget_order_id: string; amount_cny: number }>((from, to) =>
            supabase.from('receivable_payment_allocations').select('budget_order_id, amount_cny')
              .is('voided_at', null).order('id', { ascending: true }).range(from, to)),
        ])
        const arCnyByOrder = new Map<string, number>()
        ;(allocs || []).forEach(a => arCnyByOrder.set(a.budget_order_id, (arCnyByOrder.get(a.budget_order_id) || 0) + (Number(a.amount_cny) || 0)))
        // 内部订单号 = synced_orders.style_no（非 BO 财务单号、非 QM 号）；.in 分批防超长/截断
        const internalMap = new Map<string, string>()
        for (let i = 0; i < approvedIds.length; i += 500) {
          const { data: synced } = await supabase.from('synced_orders').select('budget_order_id, style_no').in('budget_order_id', approvedIds.slice(i, i + 500))
          ;(synced || []).forEach((s: Record<string, unknown>) => {
            if (s.budget_order_id && s.style_no) internalMap.set(s.budget_order_id as string, String(s.style_no))
          })
        }

        // 订单汇率表：应付折算用所属订单汇率（payable_records 无汇率列）
        const orderRateMap = new Map<string, number>()
        orders.forEach(o => orderRateMap.set(o.id, o.currency === 'CNY' ? 1 : (Number(o.exchange_rate) || 0)))

        const costByOrder = new Map<string, number>()
        costs?.forEach(r => {
          const id = r.budget_order_id
          // CNY 行汇率恒按 1，防历史数据 exchange_rate≠1 被二次折算
          const rate = (r.currency || 'CNY') === 'CNY' ? 1 : (Number(r.exchange_rate) || 1)
          const cny = (Number(r.amount) || 0) * rate
          costByOrder.set(id, (costByOrder.get(id) || 0) + cny)
        })

        const payableByOrder = new Map<string, number>()
        payables?.forEach(r => {
          const id = r.budget_order_id
          const cny = payableToCny(Number(r.amount) || 0, r.currency || 'CNY', orderRateMap.get(id))
          payableByOrder.set(id, (payableByOrder.get(id) || 0) + cny)
        })

        const list: Row[] = approved.map(o => {
          const rate = o.currency === 'CNY' ? 1 : (Number(o.exchange_rate) || 1)  // CNY 行恒 1，防历史脏数据虚增
          const revOrig = o.total_revenue || 0
          const recOrig = receivedAmount(o)
          // 已收：有回款流水→用流水合计(CNY，权威)；无流水→回退 ar_received_amount×rate
          const allocCny = arCnyByOrder.get(o.id)
          const recCny = allocCny != null ? allocCny : recOrig * rate
          const costCny = costByOrder.get(o.id) || 0
          const payCny = payableByOrder.get(o.id) || 0
          const gross = recCny - costCny
          const margin = recCny > 0 ? (gross / recCny) * 100 : 0
          return {
            id: o.id,
            order_no: o.order_no,
            internalNo: internalMap.get(o.id) || '',
            customer: o.customer?.company || '-',
            currency: o.currency || 'USD',
            rate,
            revenue_orig: revOrig,
            revenue_cny: Math.round(revOrig * rate * 100) / 100,
            received_orig: recOrig,
            received_cny: Math.round(recCny * 100) / 100,
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
    return rows.filter(r => r.order_no.toLowerCase().includes(q) || r.customer.toLowerCase().includes(q) || r.internalNo.toLowerCase().includes(q))
  }, [rows, search])

  const exportCsv = () => {
    const headers = ['内部订单号', '订单号', '客户', '币种', '汇率', '合同额(原币)', '合同额(¥)', '实际收款(原币)', '实际收款(¥)', '实际收款日', '费用归集(¥)', '应付登记(¥)', '实际毛利(¥)', '毛利率%']
    const lines = filtered.map(r => [
      r.internalNo,
      r.order_no,
      r.customer,
      r.currency,
      r.rate,
      r.revenue_orig,
      r.revenue_cny,
      r.received_orig,
      r.received_cny,
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
          <Button size="sm" onClick={exportAllInvoices} disabled={batchExporting !== null}>
            {batchExporting !== null ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
            {batchExporting !== null ? `生成中 ${batchExporting}/${filtered.length}` : '批量导出核算单(一单一Sheet)'}
          </Button>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>内部订单号</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead>客户</TableHead>
                  <TableHead>币种</TableHead>
                  <TableHead className="text-right">汇率</TableHead>
                  <TableHead className="text-right">合同额(原币)</TableHead>
                  <TableHead className="text-right">合同额(¥)</TableHead>
                  <TableHead className="text-right">实际收款(原币)</TableHead>
                  <TableHead className="text-right">实际收款(¥)</TableHead>
                  <TableHead>收款日</TableHead>
                  <TableHead className="text-right">费用归集(¥)</TableHead>
                  <TableHead className="text-right">应付登记(¥)</TableHead>
                  <TableHead className="text-right">实际毛利(¥)</TableHead>
                  <TableHead className="text-right">毛利率%</TableHead>
                  <TableHead className="text-center">核算单</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm font-medium">{r.internalNo || '—'}</TableCell>
                    <TableCell>
                      <Link href={`/orders/${r.id}`} className="text-primary hover:underline text-sm">{r.order_no}</Link>
                    </TableCell>
                    <TableCell className="text-sm">{r.customer}</TableCell>
                    <TableCell className="text-sm">{r.currency}</TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{r.currency === 'CNY' ? '—' : r.rate}</TableCell>
                    <TableCell className="text-right text-sm">{r.currency === 'CNY' ? '—' : `${r.currency} ${r.revenue_orig.toLocaleString()}`}</TableCell>
                    <TableCell className="text-right text-sm">¥{r.revenue_cny.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-sm">{r.currency === 'CNY' ? '—' : `${r.currency} ${r.received_orig.toLocaleString()}`}</TableCell>
                    <TableCell className="text-right text-sm font-medium">¥{r.received_cny.toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {r.received_at ? new Date(r.received_at).toLocaleDateString('zh-CN') : '—'}
                    </TableCell>
                    <TableCell className="text-right">¥{r.cost_cny.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-muted-foreground">¥{r.payable_cny.toLocaleString()}</TableCell>
                    <TableCell className={`text-right font-semibold ${r.gross_cny >= 0 ? 'text-green-700' : 'text-red-600'}`}>
                      ¥{r.gross_cny.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">{r.margin_pct}%</TableCell>
                    <TableCell className="text-center whitespace-nowrap">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={viewingId === r.id}
                        onClick={() => viewSettlementInvoice(r.id)} title="页面查看订单核算单">
                        {viewingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Eye className="h-3.5 w-3.5 mr-1" />查看</>}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={exportingId === r.id}
                        onClick={() => exportSettlementInvoice(r.id)} title="下载订单核算单 Excel">
                        {exportingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Download className="h-3.5 w-3.5 mr-1" />下载</>}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={15} className="text-center py-12 text-muted-foreground">暂无数据</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* 订单核算单 · 页面查看 */}
      <Dialog open={!!viewBundle} onOpenChange={(o) => { if (!o) setViewBundle(null) }}>
        <DialogContent className="sm:max-w-[min(1280px,96vw)] max-h-[90vh] overflow-y-auto">
          {viewBundle && (() => {
            const b = viewBundle
            const r2 = (n: number) => Math.round(n * 100) / 100
            const shou = r2(b.receipts.reduce((s, x) => s + (x.cny || 0), 0))
            const zhi = r2(b.expenses.reduce((s, x) => s + (x.amount || 0), 0))
            const profit = r2(shou - zhi)
            const margin = shou > 0 ? Math.round((profit / shou) * 10000) / 100 : 0
            return (
              <>
                <DialogHeader>
                  {/* 抬头优先内部订单号（财务对外口径），系统单号退化为补充信息 */}
                  <DialogTitle className="text-center">订单核算单 · {b.header.internal_no || b.header.order_no}</DialogTitle>
                </DialogHeader>
                <div className="text-xs space-y-3">
                  {(b.meta.cost_source === 'estimated' || b.meta.receipt_source === 'pending') && (
                    <p className="text-amber-600">
                      {b.meta.cost_source === 'estimated' && '⚠ 支出为预算估算（该订单费用归集暂无明细）。'}
                      {b.meta.receipt_source === 'pending' && '⚠ 暂无实际回款，收入按合同金额预填。'}
                    </p>
                  )}
                  {/* 表头信息（与订单详情「基本信息」同步：内部订单号/节拍器号/数量/日期） */}
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 border rounded-md p-3 bg-muted/20">
                    <div className="flex justify-between"><span className="text-muted-foreground">内部订单号</span><span className="font-medium">{b.header.internal_no || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">节拍器号</span><span>{b.header.metronome_no || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">系统单号</span><span className="text-muted-foreground">{b.header.order_no}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">客户名称</span><span className="font-medium">{b.header.customer_name || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">品名</span><span>{b.header.product_name || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">数量</span><span>{b.header.quantity ? `${b.header.quantity.toLocaleString()} ${b.header.quantity_unit || ''}` : '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">合同金额</span><span className="font-medium">{b.header.contract_currency === 'USD' ? '$' : '¥'}{(b.header.contract_amount || 0).toLocaleString()}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">下单日期</span><span>{b.header.order_date || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">交货日期</span><span>{b.header.delivery_date || '—'}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">订单完结时间</span><span>{b.header.completed_at || '—'}</span></div>
                  </div>

                  {/* 收 */}
                  <div>
                    <p className="font-semibold mb-1">收（回款）</p>
                    <table className="w-full border-collapse">
                      <thead><tr className="bg-muted/40 text-muted-foreground">
                        <th className="border px-2 py-1 text-left">时间</th><th className="border px-2 py-1 text-left">摘要</th>
                        <th className="border px-2 py-1 text-right">美金</th><th className="border px-2 py-1 text-right">汇率</th>
                        <th className="border px-2 py-1 text-right">金额(¥)</th><th className="border px-2 py-1 text-left">备注</th>
                      </tr></thead>
                      <tbody>
                        {b.receipts.map((x, i) => (
                          <tr key={i}>
                            <td className="border px-2 py-1">{x.date || '—'}</td><td className="border px-2 py-1">{x.description || '货款'}</td>
                            <td className="border px-2 py-1 text-right">{x.usd ? x.usd.toLocaleString() : '—'}</td>
                            <td className="border px-2 py-1 text-right">{x.rate || '—'}</td>
                            <td className="border px-2 py-1 text-right">{(x.cny || 0).toLocaleString()}</td><td className="border px-2 py-1">{x.note || ''}</td>
                          </tr>
                        ))}
                        {b.receipts.length === 0 && <tr><td className="border px-2 py-2 text-center text-muted-foreground" colSpan={6}>暂无回款</td></tr>}
                        <tr className="font-semibold bg-muted/20"><td className="border px-2 py-1" colSpan={4}>合计</td><td className="border px-2 py-1 text-right">¥{shou.toLocaleString()}</td><td className="border px-2 py-1" /></tr>
                      </tbody>
                    </table>
                  </div>

                  {/* 支 */}
                  <div>
                    <p className="font-semibold mb-1">支（成本/费用）</p>
                    <table className="w-full border-collapse">
                      <thead><tr className="bg-muted/40 text-muted-foreground">
                        <th className="border px-2 py-1 text-left">时间</th><th className="border px-2 py-1 text-left">摘要</th>
                        <th className="border px-2 py-1 text-left">供应商</th><th className="border px-2 py-1 text-left">单位</th>
                        <th className="border px-2 py-1 text-right">数量</th><th className="border px-2 py-1 text-right">单价</th>
                        <th className="border px-2 py-1 text-right">金额(¥)</th><th className="border px-2 py-1 text-left">备注</th>
                      </tr></thead>
                      <tbody>
                        {b.expenses.map((x, i) => (
                          <tr key={i}>
                            <td className="border px-2 py-1">{x.date || '—'}</td><td className="border px-2 py-1">{x.description || ''}</td>
                            <td className="border px-2 py-1">{x.supplier || '—'}</td><td className="border px-2 py-1">{x.unit || ''}</td>
                            <td className="border px-2 py-1 text-right">{x.quantity != null ? x.quantity : ''}</td>
                            <td className="border px-2 py-1 text-right">{x.unit_price != null ? x.unit_price : ''}</td>
                            <td className="border px-2 py-1 text-right">{(x.amount || 0).toLocaleString()}</td><td className="border px-2 py-1">{x.group_note || ''}</td>
                          </tr>
                        ))}
                        {b.expenses.length === 0 && <tr><td className="border px-2 py-2 text-center text-muted-foreground" colSpan={8}>暂无支出</td></tr>}
                        <tr className="font-semibold bg-muted/20"><td className="border px-2 py-1" colSpan={6}>合计</td><td className="border px-2 py-1 text-right">¥{zhi.toLocaleString()}</td><td className="border px-2 py-1" /></tr>
                      </tbody>
                    </table>
                  </div>

                  {/* 毛利 */}
                  <div className="flex justify-end gap-8 border-t pt-2 text-sm">
                    <span>毛利润 <b className={profit >= 0 ? 'text-green-700' : 'text-red-600'}>¥{profit.toLocaleString()}</b></span>
                    <span>毛利率 <b className={profit >= 0 ? 'text-green-700' : 'text-red-600'}>{margin}%</b></span>
                  </div>

                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => { const id = rows.find(r => r.order_no === b.header.order_no)?.id; if (id) exportSettlementInvoice(id) }}>
                      <Download className="h-4 w-4 mr-1" />下载 Excel
                    </Button>
                  </div>
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>
    </div>
  )
}
