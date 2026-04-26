'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Users,
  Star,
  AlertTriangle,
  Info,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CustomerData {
  customer_id: string
  customer_name: string
  country: string | null
  order_count: number
  total_sales_usd: number
  total_profit_usd: number
  avg_margin: number
  avg_payment_days: number
  grade: 'A' | 'B' | 'C' | 'D'
  recommendation: {
    type: string
    severity: 'info' | 'warning' | 'critical' | 'success'
    title: string
    message: string
    suggestedAction: string
  }
}

interface Summary {
  total_customers: number
  grade_a: number
  grade_b: number
  grade_c: number
  grade_d: number
  avg_margin: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function gradeColor(grade: string) {
  switch (grade) {
    case 'A': return 'bg-emerald-100 text-emerald-800 border-emerald-200'
    case 'B': return 'bg-blue-100 text-blue-800 border-blue-200'
    case 'C': return 'bg-yellow-100 text-yellow-800 border-yellow-200'
    case 'D': return 'bg-red-100 text-red-800 border-red-200'
    default:  return 'bg-gray-100 text-gray-800 border-gray-200'
  }
}

function gradeLabel(grade: string) {
  switch (grade) {
    case 'A': return '优质客户'
    case 'B': return '成长客户'
    case 'C': return '观察客户'
    case 'D': return '高风险客户'
    default:  return grade
  }
}

function marginColor(margin: number) {
  if (margin >= 15) return 'text-emerald-600'
  if (margin >= 10) return 'text-yellow-600'
  return 'text-red-600'
}

function severityIcon(severity: string) {
  switch (severity) {
    case 'success':  return <TrendingUp className="h-4 w-4 text-emerald-500 shrink-0" />
    case 'warning':  return <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />
    case 'critical': return <TrendingDown className="h-4 w-4 text-red-500 shrink-0" />
    default:         return <Info className="h-4 w-4 text-blue-500 shrink-0" />
  }
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

// ─── Grade Distribution Chart ─────────────────────────────────────────────────

const GRADE_COLORS: Record<string, string> = {
  A: '#10b981',
  B: '#3b82f6',
  C: '#f59e0b',
  D: '#ef4444',
}

function GradeChart({ summary }: { summary: Summary }) {
  const data = [
    { grade: 'A 优质', count: summary.grade_a, fill: GRADE_COLORS.A },
    { grade: 'B 成长', count: summary.grade_b, fill: GRADE_COLORS.B },
    { grade: 'C 观察', count: summary.grade_c, fill: GRADE_COLORS.C },
    { grade: 'D 高风险', count: summary.grade_d, fill: GRADE_COLORS.D },
  ]
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} barSize={40}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="grade" tick={{ fontSize: 12 }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
        <Tooltip formatter={(v: unknown) => [`${Number(v)} 家`, '客户数']} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map((d) => (
            <Cell key={d.grade} fill={d.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function CustomerProfitPage() {
  const [customers, setCustomers] = useState<CustomerData[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [gradeFilter, setGradeFilter] = useState<'all' | 'A' | 'B' | 'C' | 'D'>('all')
  const [selected, setSelected] = useState<CustomerData | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/profit/customers')
      if (!res.ok) {
        const j = await res.json()
        setError(j.error || '加载失败')
        return
      }
      const j = await res.json()
      setCustomers(j.customers || [])
      setSummary(j.summary || null)
    } catch {
      setError('网络错误，请重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Filtered list
  const filtered = customers.filter(c => {
    const matchSearch = !search || c.customer_name.toLowerCase().includes(search.toLowerCase())
      || (c.country || '').toLowerCase().includes(search.toLowerCase())
    const matchGrade = gradeFilter === 'all' || c.grade === gradeFilter
    return matchSearch && matchGrade
  })

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/profit-control">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">客户利润分析</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            客户 A/B/C/D 评级 · 利润贡献 · 风险建议
          </p>
        </div>
        <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* KPI Summary */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {[
            { label: '客户总数', value: summary.total_customers, icon: Users, color: 'text-blue-600' },
            { label: 'A 级客户', value: summary.grade_a, icon: Star, color: 'text-emerald-600' },
            { label: 'B 级客户', value: summary.grade_b, icon: TrendingUp, color: 'text-blue-600' },
            { label: 'C 级客户', value: summary.grade_c, icon: AlertTriangle, color: 'text-yellow-600' },
            { label: 'D 级客户', value: summary.grade_d, icon: TrendingDown, color: 'text-red-600' },
            { label: '平均毛利率', value: `${summary.avg_margin.toFixed(1)}%`, icon: BarChartIcon, color: marginColor(summary.avg_margin) },
          ].map(kpi => (
            <Card key={kpi.label}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2 mb-1">
                  <kpi.icon className={`h-4 w-4 ${kpi.color}`} />
                  <span className="text-xs text-muted-foreground">{kpi.label}</span>
                </div>
                <p className={`text-2xl font-bold ${typeof kpi.value === 'string' ? kpi.color : ''}`}>
                  {kpi.value}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Chart + Grade legend */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">客户评级分布</CardTitle>
            <CardDescription>按毛利率与账期综合评分</CardDescription>
          </CardHeader>
          <CardContent>
            {summary ? <GradeChart summary={summary} /> : (
              <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                {loading ? '加载中…' : '暂无数据'}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">评级规则说明</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { grade: 'A', desc: '利润高 + 账期短', detail: '毛利率 ≥ 15%，账期 ≤ 60 天', color: 'border-emerald-400 bg-emerald-50' },
              { grade: 'B', desc: '利润高 + 账期长', detail: '毛利率 ≥ 15%，账期 > 60 天', color: 'border-blue-400 bg-blue-50' },
              { grade: 'C', desc: '利润低 + 账期短', detail: '毛利率 < 15%，账期 ≤ 60 天', color: 'border-yellow-400 bg-yellow-50' },
              { grade: 'D', desc: '利润低 + 账期长', detail: '毛利率 < 15%，账期 > 60 天', color: 'border-red-400 bg-red-50' },
            ].map(item => (
              <div key={item.grade} className={`border-l-4 rounded-r-lg px-3 py-2 ${item.color}`}>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-sm">{item.grade}</span>
                  <span className="text-sm font-medium">{item.desc}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{item.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Input
          placeholder="搜索客户名称或国家…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex gap-1.5 flex-wrap">
          {(['all', 'A', 'B', 'C', 'D'] as const).map(g => (
            <Button
              key={g}
              variant={gradeFilter === g ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGradeFilter(g)}
            >
              {g === 'all' ? '全部' : `${g} 级`}
              {g !== 'all' && summary && (
                <span className="ml-1 text-xs opacity-70">
                  ({summary[`grade_${g.toLowerCase()}` as keyof Summary] as number})
                </span>
              )}
            </Button>
          ))}
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            客户利润排名
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              共 {filtered.length} 家客户
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">客户名称</TableHead>
                  <TableHead>国家</TableHead>
                  <TableHead className="text-right">订单数</TableHead>
                  <TableHead className="text-right">销售额 (USD)</TableHead>
                  <TableHead className="text-right">利润 (USD)</TableHead>
                  <TableHead className="text-right">平均毛利率</TableHead>
                  <TableHead className="text-right">平均账期</TableHead>
                  <TableHead className="text-center">评级</TableHead>
                  <TableHead>建议</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && !customers.length ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                      加载中…
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                      暂无数据
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map(c => (
                    <TableRow
                      key={c.customer_id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setSelected(prev => prev?.customer_id === c.customer_id ? null : c)}
                    >
                      <TableCell className="font-medium">{c.customer_name}</TableCell>
                      <TableCell className="text-muted-foreground">{c.country || '—'}</TableCell>
                      <TableCell className="text-right">{c.order_count}</TableCell>
                      <TableCell className="text-right">${fmt(c.total_sales_usd)}</TableCell>
                      <TableCell className={`text-right font-medium ${c.total_profit_usd >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {c.total_profit_usd >= 0 ? '' : '-'}${fmt(Math.abs(c.total_profit_usd))}
                      </TableCell>
                      <TableCell className={`text-right font-semibold ${marginColor(c.avg_margin)}`}>
                        {c.avg_margin.toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right">{c.avg_payment_days} 天</TableCell>
                      <TableCell className="text-center">
                        <Badge className={`border ${gradeColor(c.grade)} font-bold`} variant="outline">
                          {c.grade}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <span className="text-xs text-muted-foreground line-clamp-1">
                          {c.recommendation?.title || '—'}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Detail panel — expands when a row is clicked */}
      {selected && (
        <Card className="border-2 border-primary/20">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  {selected.customer_name}
                  <Badge className={`border ${gradeColor(selected.grade)}`} variant="outline">
                    {selected.grade} · {gradeLabel(selected.grade)}
                  </Badge>
                </CardTitle>
                <CardDescription className="mt-1">
                  {selected.country} · {selected.order_count} 笔订单
                </CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>收起</Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Stats row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: '总销售额', value: `$${fmt(selected.total_sales_usd)}` },
                { label: '总利润', value: `$${fmt(selected.total_profit_usd)}`, highlight: selected.total_profit_usd >= 0 ? 'text-emerald-600' : 'text-red-600' },
                { label: '平均毛利率', value: `${selected.avg_margin.toFixed(1)}%`, highlight: marginColor(selected.avg_margin) },
                { label: '平均账期', value: `${selected.avg_payment_days} 天` },
              ].map(s => (
                <div key={s.label} className="rounded-lg bg-muted/50 px-4 py-3">
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className={`text-lg font-bold mt-0.5 ${s.highlight || ''}`}>{s.value}</p>
                </div>
              ))}
            </div>

            {/* Recommendation */}
            {selected.recommendation && (
              <div className={`rounded-lg border px-4 py-3 flex gap-3 ${
                selected.recommendation.severity === 'success' ? 'border-emerald-200 bg-emerald-50' :
                selected.recommendation.severity === 'warning' ? 'border-yellow-200 bg-yellow-50' :
                selected.recommendation.severity === 'critical' ? 'border-red-200 bg-red-50' :
                'border-blue-200 bg-blue-50'
              }`}>
                {severityIcon(selected.recommendation.severity)}
                <div>
                  <p className="text-sm font-semibold">{selected.recommendation.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{selected.recommendation.message}</p>
                  <p className="text-xs font-medium mt-1.5 text-foreground">
                    💡 {selected.recommendation.suggestedAction}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// Tiny placeholder to satisfy the KPI icon slot (BarChart is already imported from recharts)
function BarChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="12" width="4" height="8" rx="1" /><rect x="10" y="7" width="4" height="13" rx="1" /><rect x="17" y="3" width="4" height="17" rx="1" />
    </svg>
  )
}
