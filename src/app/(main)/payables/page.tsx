'use client'

import { useState, useEffect, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  CreditCard, AlertTriangle, Clock, CheckCircle, Search, Loader2, Download, X,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { getSupplierPayments } from '@/lib/supabase/queries-v2'
import { normalizeSupplierName } from '@/lib/utils'
import { toast } from 'sonner'
import { SupplierPayableDetail } from './SupplierPayableDetail'
import type { SupplierPayment } from '@/lib/types'

// ============================================================
// 应付账款 = 费用归集中「未付」的费用，按供应商汇总 + 账龄
// 账龄按费用录入日(created_at)计算（cost_items 无到期日）。
// 在「费用归集」勾选「已付款」后，这里会自动减少。
// 付款执行仍在「付款（出纳）」模块，互不冲突。
// ============================================================

interface CostRow {
  id: string
  supplier: string
  description: string
  cost_type: string
  amountCny: number
  orderLabel: string
  createdAt: string
  agingDays: number
  // 供右侧明细「零再请求」复用的字段
  qty: number | null
  unit: string
  unit_price: number | null
  color: string | null
  rollCount: number | null
}

interface SupplierAP {
  supplier: string
  chargeCount: number
  totalChargeCny: number
  paidCny: number       // 已登记付款合计（与供应商对账单口径一致）
  unpaidCny: number     // = 费用合计 − 付款合计
  orders: string[]
  oldestAging: number   // FIFO：最早一笔未被付款冲抵的费用账龄
  items: CostRow[]      // 该供应商全部费用（按日期升序）
}

function daysSince(dateStr: string): number {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return 0
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)))
}

export default function PayablesPage() {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('unpaid')
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<CostRow[]>([])
  const [paidBySupplier, setPaidBySupplier] = useState<Record<string, number>>({})
  const [allPayments, setAllPayments] = useState<SupplierPayment[]>([])
  // 左右分栏多标签：右侧像浏览器标签一样同时打开多个供应商
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const openSupplier = (name: string) => {
    setOpenTabs(prev => prev.includes(name) ? prev : [...prev, name])
    setActiveTab(name)
  }
  const closeTab = (name: string) => {
    setOpenTabs(prev => {
      const next = prev.filter(t => t !== name)
      setActiveTab(cur => (cur === name ? (next[next.length - 1] || null) : cur))
      return next
    })
  }

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const supabase = createClient()
        // 一次性把右侧明细需要的字段也查全（含 数量/单位/单价/source_id），
        // 右侧标签直接复用，零再请求（修卡顿核心）。
        const [costRes, payList] = await Promise.all([
          fetchAll<Record<string, unknown>>((from, to) => supabase
            .from('cost_items')
            .select('id, description, amount, currency, exchange_rate, supplier, cost_type, quantity, unit, unit_price, color, roll_count, source_id, budget_order_id, delivery_date, created_at, budget_orders(order_no, quote_no)')
            .is('deleted_at', null)
            .order('created_at', { ascending: true }).order('id', { ascending: true })
            .range(from, to)),
          getSupplierPayments(),
        ])

        // 内部订单号：仅按出现过的订单取 synced_orders（一次，非每标签）；.in 列表过长时分批
        const boIds = [...new Set((costRes.data || []).map((c: Record<string, unknown>) => c.budget_order_id as string).filter(Boolean))]
        const syncMap = new Map<string, string>()
        for (let i = 0; i < boIds.length; i += 500) {
          const { data: synced } = await supabase.from('synced_orders').select('budget_order_id, style_no').in('budget_order_id', boIds.slice(i, i + 500))
          ;(synced || []).forEach((s: Record<string, unknown>) => {
            if (s.budget_order_id && s.style_no) syncMap.set(s.budget_order_id as string, String(s.style_no))
          })
        }

        const list: CostRow[] = (costRes.data || []).map((c: Record<string, unknown>) => {
          const boId = c.budget_order_id as string | null
          const bo = c.budget_orders as { order_no?: string; quote_no?: string } | null
          const quoteFallback = bo?.quote_no ? String(bo.quote_no).trim() : ''
          const orderLabel = boId ? (syncMap.get(boId) || quoteFallback || bo?.order_no || '') : ''
          const amt = Number(c.amount) || 0
          // CNY 行汇率恒按 1（防历史数据 exchange_rate≠1 被错乘），与全站口径一致
          const rate = (c.currency as string) === 'CNY' ? 1 : (Number(c.exchange_rate) || 1)
          // 数量/单位/单价：优先真实列，缺失回退 source_id JSON
          let qty = c.quantity != null ? Number(c.quantity) : null
          let unit = (c.unit as string) || ''
          let price = c.unit_price != null ? Number(c.unit_price) : null
          if (qty == null && typeof c.source_id === 'string') {
            try {
              const j = JSON.parse(c.source_id as string)
              if (j && typeof j === 'object') { qty = j.qty ?? j.quantity ?? null; unit = unit || j.unit || ''; price = price ?? j.unit_price ?? j.price ?? null }
            } catch { /* not json */ }
          }
          return {
            id: c.id as string,
            supplier: normalizeSupplierName(c.supplier as string) || '未指定供应商',
            description: (c.description as string) || '',
            cost_type: (c.cost_type as string) || '',
            amountCny: Math.round(amt * rate * 100) / 100,
            orderLabel,
            createdAt: (c.delivery_date as string) || (c.created_at as string), // 送货日期优先（财务对账口径）
            agingDays: daysSince(c.created_at as string),
            qty, unit, unit_price: price,
            color: (c.color as string) || null,
            rollCount: c.roll_count != null ? Number(c.roll_count) : null,
          }
        })
        const payMap: Record<string, number> = {}
        payList.forEach(p => { const k = normalizeSupplierName(p.supplier_name) || '未指定供应商'; payMap[k] = (payMap[k] || 0) + (Number(p.amount) || 0) })
        setRows(list)
        setPaidBySupplier(payMap)
        setAllPayments((payList || []).map(p => ({ ...p, supplier_name: normalizeSupplierName(p.supplier_name) || '未指定供应商' })))
      } catch (err) {
        console.error('加载应付失败:', err)
        toast.error('加载失败')
      }
      setLoading(false)
    }
    load()
  }, [])

  // 按供应商聚合：未付 = 费用合计 − 已登记付款（与供应商对账单一致）
  const suppliers = useMemo<SupplierAP[]>(() => {
    const map = new Map<string, SupplierAP>()
    for (const r of rows) {
      let s = map.get(r.supplier)
      if (!s) {
        s = { supplier: r.supplier, chargeCount: 0, totalChargeCny: 0, paidCny: 0, unpaidCny: 0, orders: [], oldestAging: 0, items: [] }
        map.set(r.supplier, s)
      }
      s.chargeCount += 1
      s.totalChargeCny += r.amountCny
      s.items.push(r)
      if (r.orderLabel && !s.orders.includes(r.orderLabel)) s.orders.push(r.orderLabel)
    }
    // 只有付款、没有费用的供应商也纳入（显示为多付/预付）
    for (const sup of Object.keys(paidBySupplier)) {
      if (!map.has(sup)) map.set(sup, { supplier: sup, chargeCount: 0, totalChargeCny: 0, paidCny: 0, unpaidCny: 0, orders: [], oldestAging: 0, items: [] })
    }
    return Array.from(map.values())
      .map(s => {
        const paid = paidBySupplier[s.supplier] || 0
        const unpaid = s.totalChargeCny - paid
        // FIFO 账龄：付款先冲抵最早的费用，找出第一笔未被完全冲抵的费用
        let remaining = paid
        let oldestAging = 0
        for (const c of s.items) {  // items 已按日期升序
          if (remaining >= c.amountCny - 0.005) { remaining -= c.amountCny; continue }
          oldestAging = c.agingDays
          break
        }
        return {
          ...s,
          paidCny: Math.round(paid * 100) / 100,
          totalChargeCny: Math.round(s.totalChargeCny * 100) / 100,
          unpaidCny: Math.round(unpaid * 100) / 100,
          oldestAging,
        }
      })
      .sort((a, b) => b.unpaidCny - a.unpaidCny)
  }, [rows, paidBySupplier])

  // 供右侧标签「零再请求」复用：供应商 → 该供应商的费用明细 / 付款
  const supplierMap = useMemo(() => {
    const m = new Map<string, SupplierAP>()
    suppliers.forEach(s => m.set(s.supplier, s))
    return m
  }, [suppliers])
  const paymentsBySupplier = useMemo(() => {
    const m: Record<string, SupplierPayment[]> = {}
    for (const p of allPayments) { (m[p.supplier_name] ||= []).push(p) }
    return m
  }, [allPayments])

  const hasUnpaid = (s: SupplierAP) => s.unpaidCny > 0.005
  const withUnpaid = suppliers.filter(hasUnpaid)
  const totalUnpaid = withUnpaid.reduce((s, r) => s + r.unpaidCny, 0)
  const totalPaid = suppliers.reduce((s, r) => s + r.paidCny, 0)
  const overdue60 = withUnpaid.filter(s => s.oldestAging > 60)
  const overdue60Amount = overdue60.reduce((s, r) => s + r.unpaidCny, 0)

  const filtered = useMemo(() => {
    let base = suppliers
    if (tab === 'unpaid') base = suppliers.filter(hasUnpaid)
    else if (tab === 'overdue') base = suppliers.filter(s => s.oldestAging > 60 && hasUnpaid(s))
    else if (tab === 'cleared') base = suppliers.filter(s => !hasUnpaid(s) && (s.paidCny > 0 || s.totalChargeCny > 0))
    if (search) base = base.filter(s => s.supplier.toLowerCase().includes(search.toLowerCase()))
    return base
  }, [suppliers, tab, search])

  const exportCsv = () => {
    const headers = ['供应商', '费用笔数', '费用合计(¥)', '已付(¥)', '未付(¥)', '最长账龄(天)', '关联订单']
    const lines = filtered.map(s => [
      s.supplier, s.chargeCount, s.totalChargeCny, s.paidCny, s.unpaidCny, s.oldestAging,
      `"${s.orders.join(' / ')}"`,
    ].join(','))
    const csv = [headers.join(','), ...lines].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `应付账款_未付汇总_${new Date().toISOString().substring(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('CSV已下载')
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="应付账款管理" subtitle="左侧选供应商，右侧像网页标签一样可同时打开多个对比 · 费用归集 − 已登记付款 = 实际未付" />

      {/* 顶部 KPI（紧凑） */}
      <div className="px-4 md:px-6 pt-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50"><CreditCard className="h-4 w-4 text-blue-600" /></div>
              <div><p className="text-xs text-muted-foreground">应付总额（未付）</p><p className="text-xl font-bold">¥{totalUnpaid.toLocaleString()}</p></div>
            </CardContent>
          </Card>
          <Card className={overdue60Amount > 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className={`p-2 rounded-lg ${overdue60Amount > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                <AlertTriangle className={`h-4 w-4 ${overdue60Amount > 0 ? 'text-red-600' : 'text-gray-400'}`} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">超60天应付</p>
                <p className={`text-xl font-bold ${overdue60Amount > 0 ? 'text-red-600' : ''}`}>¥{overdue60Amount.toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">{overdue60.length} 个供应商</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-50"><Clock className="h-4 w-4 text-amber-600" /></div>
              <div><p className="text-xs text-muted-foreground">待付供应商</p><p className="text-xl font-bold">{withUnpaid.length}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-50"><CheckCircle className="h-4 w-4 text-green-600" /></div>
              <div><p className="text-xs text-muted-foreground">已付累计</p><p className="text-xl font-bold text-green-600">¥{totalPaid.toLocaleString()}</p></div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 左右分栏：左供应商列表 + 右多标签明细（像浏览器标签同时打开多个） */}
      <div className="flex-1 flex overflow-hidden mt-3 border-t min-h-0">
        {/* 左：供应商列表 */}
        <div className="w-80 shrink-0 border-r flex flex-col bg-muted/10">
          <div className="p-3 space-y-2 border-b">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="搜索供应商..." className="pl-9 h-9" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full grid grid-cols-4 h-8">
                <TabsTrigger value="unpaid" className="text-xs px-1">待付({withUnpaid.length})</TabsTrigger>
                <TabsTrigger value="overdue" className="text-xs px-1">超60天({overdue60.length})</TabsTrigger>
                <TabsTrigger value="cleared" className="text-xs px-1">已付清</TabsTrigger>
                <TabsTrigger value="all" className="text-xs px-1">全部({suppliers.length})</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>共 {filtered.length} 家</span>
              <button onClick={exportCsv} disabled={filtered.length === 0} className="text-primary disabled:opacity-40 inline-flex items-center gap-1"><Download className="h-3 w-3" />导出CSV</button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground text-sm">
                <Clock className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>{rows.length === 0 ? '暂无费用记录' : '当前筛选下无供应商'}</p>
              </div>
            ) : filtered.map(s => {
              const unpaidShown = hasUnpaid(s)
              const isActive = activeTab === s.supplier
              const isOpen = openTabs.includes(s.supplier)
              return (
                <button
                  key={s.supplier}
                  onClick={() => openSupplier(s.supplier)}
                  className={`w-full text-left px-3 py-2.5 border-b border-border/60 hover:bg-muted/50 transition ${isActive ? 'bg-primary/10 border-l-2 border-l-primary' : isOpen ? 'bg-muted/30' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{s.supplier}</span>
                    <span className={`text-sm font-semibold shrink-0 ${unpaidShown ? 'text-red-600' : 'text-green-600'}`}>
                      {unpaidShown ? `¥${s.unpaidCny.toLocaleString()}` : (s.unpaidCny < -0.005 ? '多付' : '已结清')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-0.5 text-[11px] text-muted-foreground">
                    <span>{s.chargeCount}笔 · {s.orders.length}单</span>
                    {unpaidShown && <span className={s.oldestAging > 60 ? 'text-red-500 font-medium' : ''}>{s.oldestAging}天</span>}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* 右：多标签明细 */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {openTabs.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <CreditCard className="h-10 w-10 opacity-30 mb-3" />
              <p className="text-sm">从左侧点击供应商查看应付明细</p>
              <p className="text-xs mt-1">可点击多个，像浏览器标签一样同时打开对比</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1 border-b px-2 py-1.5 overflow-x-auto bg-muted/20">
                {openTabs.map(name => (
                  <div
                    key={name}
                    onClick={() => setActiveTab(name)}
                    className={`group flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-md text-sm cursor-pointer whitespace-nowrap shrink-0 ${activeTab === name ? 'bg-background border shadow-sm font-medium' : 'hover:bg-background/60 text-muted-foreground'}`}
                  >
                    <span className="truncate max-w-[140px]">{name}</span>
                    <span
                      onClick={(e) => { e.stopPropagation(); closeTab(name) }}
                      className="rounded p-0.5 hover:bg-muted text-muted-foreground hover:text-foreground"
                    ><X className="h-3 w-3" /></span>
                  </div>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto min-w-0">
                {openTabs.map(name => (
                  <div key={name} className={activeTab === name ? '' : 'hidden'}>
                    <SupplierPayableDetail supplierName={name} lines={supplierMap.get(name)?.items || []} payments={paymentsBySupplier[name] || []} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
