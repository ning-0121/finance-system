'use client'

import { use, useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import {
  ArrowLeft, Plus, Loader2, AlertTriangle, CheckCircle, Info,
  TrendingDown, TrendingUp, RefreshCw, Trash2,
} from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell, BarChart, Bar,
} from 'recharts'
import Link from 'next/link'
import { toast } from 'sonner'
import { RISK_CONFIG, type MarginRisk, type FXScenario } from '@/lib/profit-calculator'
import type { RecommendationSeverity } from '@/lib/profit-recommendation-engine'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface StyleRow {
  id: string
  style_no: string
  product_category: string | null
  size_type: string
  qty: number
  selling_price_per_piece_usd: number
  fabric_usage_kg_per_piece: number
  fabric_price_per_kg_rmb: number
  cmt_cost_per_piece_rmb: number
  trim_cost_per_piece_rmb: number
  packing_cost_per_piece_rmb: number
  freight_cost_per_piece_usd: number
  other_cost_per_piece_rmb: number
  exchange_rate: number
  // Computed
  fabric_cost_per_piece_rmb: number
  rmb_cost_per_piece_rmb: number
  total_cost_per_piece_usd: number
  profit_per_piece_usd: number
  margin_per_style: number
  risk_status: MarginRisk
  recommendations: Array<{
    type: string; severity: RecommendationSeverity; title: string
    message: string; suggestedAction: string; expectedMarginImprovement?: number
  }>
}

interface OrderDetail {
  id: string
  order_no: string
  order_date: string
  currency: string
  exchange_rate: number
  total_revenue: number
  total_cost: number
  status: string
  customer: { company: string; country: string | null } | null
  computed_profit: {
    sales_amount_usd: number
    total_cost_usd: number
    gross_profit_usd: number
    gross_margin: number
  }
  risk_status: MarginRisk
}

// ─────────────────────────────────────────────────────────────
// Severity icon helper
// ─────────────────────────────────────────────────────────────

function SeverityIcon({ s }: { s: RecommendationSeverity }) {
  if (s === 'critical') return <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
  if (s === 'warning') return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
  if (s === 'success') return <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
  return <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
}

// ─────────────────────────────────────────────────────────────
// Default new style form
// ─────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  style_no: '',
  product_category: '',
  size_type: 'missy',
  qty: 0,
  selling_price_per_piece_usd: 0,
  fabric_usage_kg_per_piece: 0,
  fabric_price_per_kg_rmb: 0,
  cmt_cost_per_piece_rmb: 0,
  trim_cost_per_piece_rmb: 0,
  packing_cost_per_piece_rmb: 0,
  freight_cost_per_piece_usd: 0,
  other_cost_per_piece_rmb: 0,
  exchange_rate: 7.15,
}

const CATEGORIES = [
  'leggings', 'flare leggings', 'biker shorts', 'sports bra', 'hoodie',
  'jacket', 't-shirt', 'shorts', 'skort', 'jogger', 'fleece set', 'plus size set', 'other',
]

// ─────────────────────────────────────────────────────────────
// Page Component
// ─────────────────────────────────────────────────────────────

export default function OrderProfitDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params)
  const [order, setOrder] = useState<OrderDetail | null>(null)
  const [styles, setStyles] = useState<StyleRow[]>([])
  const [fxScenarios, setFxScenarios] = useState<FXScenario[]>([])
  const [recommendations, setRecommendations] = useState<StyleRow['recommendations']>([])
  const [loading, setLoading] = useState(true)
  const [showAddStyle, setShowAddStyle] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [customRate, setCustomRate] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/profit/orders/${orderId}`)
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setOrder(d.order)
      setStyles(d.styles || [])
      setFxScenarios(d.fx_scenarios || [])
      setRecommendations(d.recommendations || [])
      // Pre-fill exchange rate in form
      setForm(f => ({ ...f, exchange_rate: d.order?.exchange_rate || 7.15 }))
    } catch (e) {
      toast.error(`加载失败: ${e instanceof Error ? e.message : '未知'}`)
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => { load() }, [load])

  // ── Add custom FX rate to scenarios ──────────────────────
  const addCustomRate = async () => {
    const rate = parseFloat(customRate)
    if (!rate || rate <= 0 || !order) return
    try {
      const res = await fetch('/api/profit/fx?action=simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          total_revenue_usd: order.computed_profit.sales_amount_usd,
          total_cost_rmb: order.total_cost,
          locked_rate: order.exchange_rate,
          custom_rates: [rate],
        }),
      })
      const d = await res.json()
      if (d.scenarios) {
        const newScenarios = [...fxScenarios]
        for (const s of d.scenarios) {
          if (!newScenarios.find(x => Math.abs(x.rate - s.rate) < 0.001)) {
            newScenarios.push(s)
          }
        }
        setFxScenarios(newScenarios.sort((a, b) => a.rate - b.rate))
      }
      setCustomRate('')
    } catch { /* silent */ }
  }

  // ── Save new style ────────────────────────────────────────
  const handleSaveStyle = async () => {
    if (!form.style_no.trim()) { toast.error('请填写款号'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/profit/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, budget_order_id: orderId }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      toast.success('款式已添加')
      setShowAddStyle(false)
      setForm(EMPTY_FORM)
      load()
    } catch (e) {
      toast.error(`保存失败: ${e instanceof Error ? e.message : '未知'}`)
    } finally {
      setSaving(false)
    }
  }

  // ── Delete style ──────────────────────────────────────────
  const handleDeleteStyle = async (id: string) => {
    if (!confirm('确定删除该款式？')) return
    setDeletingId(id)
    try {
      const res = await fetch(`/api/profit/styles/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success('已删除')
      load()
    } catch (e) {
      toast.error(`删除失败: ${e instanceof Error ? e.message : '未知'}`)
    } finally {
      setDeletingId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <Header title="订单利润详情" subtitle="款式成本拆解 · 建议 · 汇率模拟" />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="flex flex-col h-full">
        <Header title="订单利润详情" subtitle="" />
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          订单不存在或无权访问
        </div>
      </div>
    )
  }

  const rc = RISK_CONFIG[order.risk_status]
  const lockedRate = order.exchange_rate || 7

  // Severity bg colors
  const severityBg: Record<RecommendationSeverity, string> = {
    critical: 'border-l-4 border-red-500 bg-red-50/40',
    warning: 'border-l-4 border-amber-400 bg-amber-50/40',
    info: 'border-l-4 border-blue-400 bg-blue-50/30',
    success: 'border-l-4 border-green-500 bg-green-50/30',
  }

  return (
    <div className="flex flex-col h-full">
      <Header
        title={`${order.order_no} — 利润详情`}
        subtitle={`${order.customer?.company || '—'} · ${order.order_date}`}
      />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* Back + Actions */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Link href="/profit-control">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />返回列表
            </Button>
          </Link>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-4 w-4" /></Button>
            <Button size="sm" onClick={() => setShowAddStyle(true)}>
              <Plus className="h-4 w-4 mr-1" />添加款式
            </Button>
          </div>
        </div>

        {/* ── Order Summary KPIs ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">销售额 (USD)</p>
              <p className="text-xl font-bold">${order.computed_profit.sales_amount_usd.toLocaleString('en', { maximumFractionDigits: 0 })}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">成本 (USD)</p>
              <p className="text-xl font-bold">${order.computed_profit.total_cost_usd.toLocaleString('en', { maximumFractionDigits: 0 })}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">毛利 (USD)</p>
              <p className={`text-xl font-bold ${order.computed_profit.gross_profit_usd >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {order.computed_profit.gross_profit_usd >= 0 ? '+' : ''}
                ${order.computed_profit.gross_profit_usd.toLocaleString('en', { maximumFractionDigits: 0 })}
              </p>
            </CardContent>
          </Card>
          <Card className={rc.bg + ' ' + rc.border}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">毛利率</p>
              <p className={`text-xl font-bold ${rc.color}`}>
                {order.computed_profit.gross_margin.toFixed(1)}%
              </p>
              <Badge variant={rc.badge} className="text-[10px] mt-1">{rc.label}</Badge>
            </CardContent>
          </Card>
        </div>

        {/* ── Recommendations Panel ── */}
        {recommendations.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                利润优化建议 ({recommendations.length} 条)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {recommendations.map((r, i) => (
                <div key={i} className={`p-3 rounded-md ${severityBg[r.severity]}`}>
                  <div className="flex items-start gap-2">
                    <SeverityIcon s={r.severity} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{r.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{r.message}</p>
                      <p className="text-xs font-medium mt-1">
                        <span className="text-muted-foreground">建议：</span>{r.suggestedAction}
                      </p>
                      {r.expectedMarginImprovement != null && (
                        <Badge variant="outline" className="mt-1 text-[10px]">
                          预计提升 +{r.expectedMarginImprovement}%
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* ── Style Profit Breakdown ── */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">款式成本拆解 ({styles.length} 款)</CardTitle>
              {styles.length === 0 && (
                <p className="text-xs text-muted-foreground">点击「添加款式」录入各款式成本，获取精确单件利润分析</p>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            {styles.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground text-sm">
                <p>暂无款式数据</p>
                <p className="text-xs mt-1">利润数据来源于订单预算总额，添加款式后可获得精确单件成本拆解</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 text-xs">
                    <TableHead>款号</TableHead>
                    <TableHead>品类</TableHead>
                    <TableHead className="text-right">件数</TableHead>
                    <TableHead className="text-right">售价/件</TableHead>
                    <TableHead className="text-right">面料¥</TableHead>
                    <TableHead className="text-right">CMT ¥</TableHead>
                    <TableHead className="text-right">辅料 ¥</TableHead>
                    <TableHead className="text-right">包装 ¥</TableHead>
                    <TableHead className="text-right">运费 $</TableHead>
                    <TableHead className="text-right">总成本 $</TableHead>
                    <TableHead className="text-right">利润/件 $</TableHead>
                    <TableHead className="text-right">毛利率</TableHead>
                    <TableHead className="text-center w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {styles.map(s => {
                    const src = RISK_CONFIG[s.risk_status]
                    return (
                      <TableRow key={s.id} className={s.risk_status === 'critical' ? 'bg-red-50/30' : ''}>
                        <TableCell className="font-mono text-xs font-medium">{s.style_no}</TableCell>
                        <TableCell className="text-xs">{s.product_category || '—'}</TableCell>
                        <TableCell className="text-right text-xs">{s.qty.toLocaleString()}</TableCell>
                        <TableCell className="text-right text-xs">${s.selling_price_per_piece_usd.toFixed(2)}</TableCell>
                        <TableCell className="text-right text-xs">¥{s.fabric_cost_per_piece_rmb?.toFixed(2) ?? '—'}</TableCell>
                        <TableCell className="text-right text-xs">¥{s.cmt_cost_per_piece_rmb.toFixed(2)}</TableCell>
                        <TableCell className="text-right text-xs">¥{s.trim_cost_per_piece_rmb.toFixed(2)}</TableCell>
                        <TableCell className="text-right text-xs">¥{s.packing_cost_per_piece_rmb.toFixed(2)}</TableCell>
                        <TableCell className="text-right text-xs">${s.freight_cost_per_piece_usd.toFixed(3)}</TableCell>
                        <TableCell className="text-right text-xs font-medium">${s.total_cost_per_piece_usd.toFixed(2)}</TableCell>
                        <TableCell className={`text-right text-xs font-semibold ${s.profit_per_piece_usd >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {s.profit_per_piece_usd >= 0 ? '+' : ''}${s.profit_per_piece_usd.toFixed(2)}
                        </TableCell>
                        <TableCell className={`text-right text-xs font-bold ${src.color}`}>
                          {s.margin_per_style.toFixed(1)}%
                        </TableCell>
                        <TableCell className="text-center">
                          <Button
                            size="sm" variant="ghost"
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600"
                            onClick={() => handleDeleteStyle(s.id)}
                            disabled={deletingId === s.id}
                          >
                            {deletingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* ── FX Impact Simulator ── */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-blue-500" />
                汇率影响模拟
                <span className="text-xs text-muted-foreground font-normal ml-1">锁汇率 {lockedRate.toFixed(2)}</span>
              </CardTitle>
              <div className="flex items-center gap-2">
                <Input
                  className="w-24 h-7 text-xs"
                  placeholder="自定义汇率"
                  value={customRate}
                  onChange={e => setCustomRate(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addCustomRate()}
                />
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addCustomRate}>
                  添加
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {fxScenarios.length > 0 && (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30 text-xs">
                        <TableHead>汇率</TableHead>
                        <TableHead className="text-right">总成本 (USD)</TableHead>
                        <TableHead className="text-right">毛利 (USD)</TableHead>
                        <TableHead className="text-right">毛利率</TableHead>
                        <TableHead className="text-right">利润变化</TableHead>
                        <TableHead className="text-center">风险</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {fxScenarios.map((s, i) => {
                        const isLocked = Math.abs(s.rate - lockedRate) < 0.01
                        const margin = s.gross_margin
                        const risk = margin < 10 ? 'critical' : margin < 15 ? 'warning' : 'healthy'
                        const rc2 = RISK_CONFIG[risk]
                        return (
                          <TableRow key={i} className={isLocked ? 'bg-blue-50/40 font-semibold' : ''}>
                            <TableCell className="text-xs font-mono">
                              {s.rate.toFixed(2)} {isLocked && <Badge variant="outline" className="text-[9px] ml-1">锁汇</Badge>}
                            </TableCell>
                            <TableCell className="text-right text-xs">${s.total_cost_usd.toLocaleString('en', { maximumFractionDigits: 0 })}</TableCell>
                            <TableCell className={`text-right text-xs font-semibold ${s.gross_profit_usd >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                              ${s.gross_profit_usd.toLocaleString('en', { maximumFractionDigits: 0 })}
                            </TableCell>
                            <TableCell className={`text-right text-xs font-bold ${rc2.color}`}>
                              {s.gross_margin.toFixed(1)}%
                            </TableCell>
                            <TableCell className={`text-right text-xs ${s.profit_change_usd > 0 ? 'text-green-600' : s.profit_change_usd < 0 ? 'text-red-600' : 'text-muted-foreground'}`}>
                              {s.profit_change_usd === 0 ? '—' : `${s.profit_change_usd > 0 ? '+' : ''}$${s.profit_change_usd.toLocaleString('en', { maximumFractionDigits: 0 })}`}
                            </TableCell>
                            <TableCell className="text-center">
                              <Badge variant={rc2.badge} className="text-[10px]">{rc2.label}</Badge>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>

                <div className="mt-4">
                  <p className="text-xs text-muted-foreground mb-2">汇率 vs 毛利率趋势</p>
                  <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={fxScenarios} margin={{ top: 5, right: 15, left: -10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="rate" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} unit="%" domain={['auto', 'auto']} />
                      <Tooltip formatter={(v) => [`${Number(v).toFixed(1)}%`, '毛利率']} />
                      <ReferenceLine y={15} stroke="#22c55e" strokeDasharray="4 2" label={{ value: '15%目标', position: 'right', fontSize: 9 }} />
                      <ReferenceLine y={10} stroke="#ef4444" strokeDasharray="4 2" label={{ value: '10%警戒', position: 'right', fontSize: 9 }} />
                      <Line type="monotone" dataKey="gross_margin" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </CardContent>
        </Card>

      </div>

      {/* ── Add Style Dialog ── */}
      <Dialog open={showAddStyle} onOpenChange={o => { if (!o) { setShowAddStyle(false); setForm(EMPTY_FORM) } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>添加款式成本</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            {/* Style Info */}
            <div className="col-span-2 grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">款号 *</Label>
                <Input className="h-8 text-sm mt-1" value={form.style_no} onChange={e => setForm(f => ({ ...f, style_no: e.target.value }))} placeholder="如 LS2024-001" />
              </div>
              <div>
                <Label className="text-xs">品类</Label>
                <Select value={form.product_category} onValueChange={v => setForm(f => ({ ...f, product_category: v ?? f.product_category }))}>
                  <SelectTrigger className="h-8 text-sm mt-1"><SelectValue placeholder="选择品类" /></SelectTrigger>
                  <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">尺码类型</Label>
                <Select value={form.size_type} onValueChange={v => setForm(f => ({ ...f, size_type: v ?? f.size_type }))}>
                  <SelectTrigger className="h-8 text-sm mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="junior">Junior</SelectItem>
                    <SelectItem value="missy">Missy</SelectItem>
                    <SelectItem value="plus">Plus</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Quantity + Price */}
            <div>
              <Label className="text-xs">件数</Label>
              <Input className="h-8 text-sm mt-1" type="number" value={form.qty || ''} onChange={e => setForm(f => ({ ...f, qty: parseInt(e.target.value) || 0 }))} />
            </div>
            <div>
              <Label className="text-xs">售价 / 件 (USD)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.01" value={form.selling_price_per_piece_usd || ''} onChange={e => setForm(f => ({ ...f, selling_price_per_piece_usd: parseFloat(e.target.value) || 0 }))} />
            </div>

            <Separator className="col-span-2" />

            {/* Fabric */}
            <div>
              <Label className="text-xs">面料用量 (kg/件)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.001" value={form.fabric_usage_kg_per_piece || ''} onChange={e => setForm(f => ({ ...f, fabric_usage_kg_per_piece: parseFloat(e.target.value) || 0 }))} />
            </div>
            <div>
              <Label className="text-xs">面料单价 (¥/kg)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.1" value={form.fabric_price_per_kg_rmb || ''} onChange={e => setForm(f => ({ ...f, fabric_price_per_kg_rmb: parseFloat(e.target.value) || 0 }))} />
            </div>

            {/* CMT + Trims */}
            <div>
              <Label className="text-xs">加工费 CMT (¥/件)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.1" value={form.cmt_cost_per_piece_rmb || ''} onChange={e => setForm(f => ({ ...f, cmt_cost_per_piece_rmb: parseFloat(e.target.value) || 0 }))} />
            </div>
            <div>
              <Label className="text-xs">辅料 (¥/件)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.1" value={form.trim_cost_per_piece_rmb || ''} onChange={e => setForm(f => ({ ...f, trim_cost_per_piece_rmb: parseFloat(e.target.value) || 0 }))} />
            </div>

            {/* Packing + Freight */}
            <div>
              <Label className="text-xs">包装 (¥/件)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.1" value={form.packing_cost_per_piece_rmb || ''} onChange={e => setForm(f => ({ ...f, packing_cost_per_piece_rmb: parseFloat(e.target.value) || 0 }))} />
            </div>
            <div>
              <Label className="text-xs">运费 ($/件)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.001" value={form.freight_cost_per_piece_usd || ''} onChange={e => setForm(f => ({ ...f, freight_cost_per_piece_usd: parseFloat(e.target.value) || 0 }))} />
            </div>

            {/* Other + FX */}
            <div>
              <Label className="text-xs">其他 (¥/件)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.1" value={form.other_cost_per_piece_rmb || ''} onChange={e => setForm(f => ({ ...f, other_cost_per_piece_rmb: parseFloat(e.target.value) || 0 }))} />
            </div>
            <div>
              <Label className="text-xs">汇率 (USD/CNY)</Label>
              <Input className="h-8 text-sm mt-1" type="number" step="0.01" value={form.exchange_rate || ''} onChange={e => setForm(f => ({ ...f, exchange_rate: parseFloat(e.target.value) || 7 }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddStyle(false)}>取消</Button>
            <Button onClick={handleSaveStyle} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
              保存款式
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
