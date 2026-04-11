'use client'

import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
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
import type { Explanation } from '@/lib/engines/explanation-engine'

// Trust 等级颜色
const TRUST_COLORS: Record<string, string> = {
  T0: '#ef4444',
  T1: '#f97316',
  T2: '#eab308',
  T3: '#22c55e',
  T4: '#3b82f6',
  T5: '#8b5cf6',
}

const SEVERITY_BG: Record<string, string> = {
  critical: 'bg-red-900/50 border-red-700',
  warning: 'bg-amber-900/50 border-amber-700',
  info: 'bg-blue-900/50 border-blue-700',
}

interface OverviewData {
  risk: {
    criticalFindings: number
    activeFreezes: number
    lowTrustCount: number
    highRiskOrders: number
  }
  pending: {
    pendingApprovals: number
    pendingPayments: number
    openRiskEvents: number
    closingPending: number
    closingTotal: number
  }
  health: {
    glBalanced: boolean
    trustAvg: number
    rollbackCount: number
    rejectCount: number
  }
  trends: {
    profitTrend: number
    trustDowngrades: number
    monthlyProfit: { month: string; revenue: number; cost: number; profit: number; margin: number }[]
  }
  explanations: Explanation[]
  kpi: {
    revenue: number
    profit: number
    margin: number
    orderCount: number
    cashflow: number
    riskOrders: number
    pendingApprovals: number
    freezes: number
    trustAvg: number
  }
  trust: {
    byLevel: Record<string, number>
    lowTrust: { subjectType: string; subjectId: string; score: number; level: string }[]
  }
  timeline: { id: string; event_title: string; event_type: string; entity_type: string; created_at: string }[]
  closing: {
    periodCode: string
    items: { checkKey: string; checkLabel: string; status: string }[]
    pending: number
    total: number
  }
  freezes: { entity_type: string; entity_name: string; freeze_reason: string }[]
}

export default function DashboardPage() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/control-center/overview')
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false))

    // 自动刷新每60秒
    const timer = setInterval(() => {
      fetch('/api/control-center/overview')
        .then(r => r.json())
        .then(d => setData(d))
        .catch(() => {})
    }, 60000)
    return () => clearInterval(timer)
  }, [])

  if (loading || !data) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950 text-white">
        <Loader2 className="h-10 w-10 animate-spin text-gray-400" />
      </div>
    )
  }

  const formatNum = (n: number) => {
    if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`
    return n.toLocaleString()
  }

  // 利润图表数据
  const profitChartData = data.trends.monthlyProfit.map(m => ({
    name: m.month.substring(5),
    revenue: Math.round(m.revenue / 10000),
    profit: Math.round(m.profit / 10000),
  }))

  // Trust 分布数据
  const trustDistData = Object.entries(data.trust.byLevel).map(([level, count]) => ({
    name: level,
    value: count as number,
  }))

  // 冻结按类型统计
  const freezeByType: Record<string, number> = {}
  for (const f of data.freezes) {
    freezeByType[f.entity_type] = (freezeByType[f.entity_type] || 0) + 1
  }
  const freezeChartData = Object.entries(freezeByType).map(([type, count]) => ({
    name: type,
    value: count,
  }))

  // 月结进度
  const closingPassed = data.closing.items.filter(c => c.status === 'passed' || c.status === 'overridden').length
  const closingProgress = data.closing.total > 0 ? Math.round((closingPassed / data.closing.total) * 100) : 0

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4 space-y-4">
      {/* Title */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-wide">财务控制中心</h1>
        <span className="text-sm text-gray-400">
          {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}
          {' '}
          {new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      {/* Row 1: KPI Numbers */}
      <div className="grid grid-cols-4 lg:grid-cols-8 gap-3">
        {[
          { label: '总收入', value: `${formatNum(data.kpi.revenue)}`, color: 'text-green-400' },
          { label: '总利润', value: `${formatNum(data.kpi.profit)}`, color: 'text-emerald-400' },
          { label: '平均利润率', value: `${data.kpi.margin}%`, color: 'text-cyan-400' },
          { label: '现金流', value: `${formatNum(data.kpi.cashflow)}`, color: 'text-blue-400' },
          { label: '风险订单', value: `${data.kpi.riskOrders}`, color: data.kpi.riskOrders > 0 ? 'text-red-400' : 'text-gray-400' },
          { label: '待审批', value: `${data.kpi.pendingApprovals}`, color: data.kpi.pendingApprovals > 0 ? 'text-amber-400' : 'text-gray-400' },
          { label: '冻结数', value: `${data.kpi.freezes}`, color: data.kpi.freezes > 0 ? 'text-orange-400' : 'text-gray-400' },
          { label: 'Trust均分', value: `${data.kpi.trustAvg}`, color: data.kpi.trustAvg >= 60 ? 'text-green-400' : 'text-amber-400' },
        ].map(kpi => (
          <div key={kpi.label} className="bg-gray-900 rounded-lg p-3 border border-gray-800">
            <p className="text-xs text-gray-500 mb-1">{kpi.label}</p>
            <p className={`text-2xl lg:text-3xl font-bold ${kpi.color}`}>{kpi.value}</p>
          </div>
        ))}
      </div>

      {/* Row 2: Profit Chart + Top 5 Customer */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Profit Trend Bar Chart */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">月度利润趋势 (万元)</h3>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={profitChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis dataKey="name" stroke="#9ca3af" fontSize={12} />
                <YAxis stroke="#9ca3af" fontSize={12} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px', color: '#fff' }}
                  labelStyle={{ color: '#9ca3af' }}
                />
                <Bar dataKey="revenue" name="收入" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="profit" name="利润" radius={[4, 4, 0, 0]}>
                  {profitChartData.map((entry, index) => (
                    <Cell key={index} fill={entry.profit >= 0 ? '#22c55e' : '#ef4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Top 5 Low Trust */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">低信任实体 TOP 5</h3>
          <div className="space-y-2">
            {data.trust.lowTrust.length === 0 ? (
              <p className="text-gray-500 text-sm">无低信任实体</p>
            ) : (
              data.trust.lowTrust.slice(0, 5).map((item, i) => (
                <div key={i} className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-5">{i + 1}.</span>
                    <span className="text-sm">{item.subjectId}</span>
                    <span className="text-xs text-gray-500">{item.subjectType}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono">{item.score}</span>
                    <span
                      className="text-xs font-bold px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: TRUST_COLORS[item.level] + '30', color: TRUST_COLORS[item.level] }}
                    >
                      {item.level}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Row 3: Trust Distribution + Freeze + Explanations */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Trust T0-T5 Distribution */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">信任等级分布</h3>
          <div className="space-y-2">
            {trustDistData.map(item => {
              const total = trustDistData.reduce((s, d) => s + d.value, 0) || 1
              const pct = Math.round((item.value / total) * 100)
              return (
                <div key={item.name} className="flex items-center gap-2">
                  <span
                    className="text-xs font-bold w-8 text-center px-1 py-0.5 rounded"
                    style={{ backgroundColor: TRUST_COLORS[item.name] + '30', color: TRUST_COLORS[item.name] }}
                  >
                    {item.name}
                  </span>
                  <div className="flex-1 h-4 bg-gray-800 rounded overflow-hidden">
                    <div
                      className="h-full rounded transition-all"
                      style={{ width: `${pct}%`, backgroundColor: TRUST_COLORS[item.name] }}
                    />
                  </div>
                  <span className="text-xs text-gray-400 w-8 text-right">{item.value}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Freeze by Type */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">冻结实体类型</h3>
          {freezeChartData.length === 0 ? (
            <p className="text-gray-500 text-sm">无冻结实体</p>
          ) : (
            <div className="space-y-2">
              {freezeChartData.map(item => (
                <div key={item.name} className="flex items-center justify-between bg-gray-800/50 rounded px-3 py-2">
                  <span className="text-sm">{item.name}</span>
                  <span className="text-lg font-bold text-orange-400">{item.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Explanations */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">智能分析</h3>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {data.explanations.slice(0, 5).map((exp, i) => (
              <div key={i} className={`text-xs rounded px-2 py-1.5 border ${SEVERITY_BG[exp.severity]}`}>
                <span className="text-gray-300">[{exp.category}]</span>{' '}
                <span className="text-gray-100">{exp.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Row 4: Closing Progress + Timeline */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Month-end Closing Progress */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">
            月结进度 ({data.closing.periodCode})
          </h3>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="flex-1 h-6 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all bg-gradient-to-r from-blue-500 to-cyan-400"
                  style={{ width: `${closingProgress}%` }}
                />
              </div>
              <span className="text-lg font-bold text-cyan-400">{closingProgress}%</span>
            </div>
            <p className="text-xs text-gray-500">
              {closingPassed}/{data.closing.total} 项检查通过 | {data.closing.pending} 项待处理
            </p>
            {data.closing.items.length > 0 && (
              <div className="grid grid-cols-3 gap-1 mt-2">
                {data.closing.items.map(item => {
                  const colors: Record<string, string> = {
                    passed: 'bg-green-900/50 text-green-400',
                    failed: 'bg-red-900/50 text-red-400',
                    pending: 'bg-gray-800 text-gray-500',
                    overridden: 'bg-amber-900/50 text-amber-400',
                  }
                  return (
                    <div key={item.checkKey} className={`text-xs rounded px-1.5 py-1 text-center ${colors[item.status] || colors.pending}`}>
                      {item.checkLabel}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Latest Timeline Events */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">最新事件</h3>
          <div className="space-y-2">
            {data.timeline.length === 0 ? (
              <p className="text-gray-500 text-sm">暂无事件</p>
            ) : (
              data.timeline.slice(0, 5).map(evt => (
                <div key={evt.id} className="flex items-start gap-2 bg-gray-800/50 rounded px-3 py-2">
                  <div className="w-2 h-2 mt-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-200 truncate">{evt.event_title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-gray-500">{evt.entity_type}</span>
                      <span className="text-xs text-gray-600">
                        {new Date(evt.created_at).toLocaleString('zh-CN', {
                          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
