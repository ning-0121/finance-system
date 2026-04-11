'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Loader2,
  AlertCircle,
  AlertTriangle,
  Info,
  Shield,
  Snowflake,
  TrendingUp,
  TrendingDown,
  CheckCircle,
  XCircle,
  ArrowRight,
  BarChart3,
  Clock,
  FileSearch,
  Lock,
  Sparkles,
  Activity,
  Monitor,
} from 'lucide-react'
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import type { Explanation } from '@/lib/engines/explanation-engine'

// 角色配置
const ROLE_CONFIG: Record<string, { label: string; sections: string[] }> = {
  admin: { label: '老板视图', sections: ['risk', 'pending', 'health', 'trends', 'explanation'] },
  finance_manager: { label: '财务总监视图', sections: ['risk', 'pending', 'health', 'trends', 'explanation'] },
  finance_staff: { label: '财务视图', sections: ['pending', 'explanation'] },
  sales: { label: '工作视图', sections: ['pending', 'explanation'] },
  procurement: { label: '工作视图', sections: ['pending', 'explanation'] },
  cashier: { label: '工作视图', sections: ['pending', 'explanation'] },
}

// 控制中心子模块
const MODULES = [
  { key: 'closing', label: '月结管理', icon: Clock, href: '/control-center/closing', desc: '期间关闭检查' },
  { key: 'audit', label: '财务稽核', icon: FileSearch, href: '/control-center/audit', desc: '异常检测与处理' },
  { key: 'freeze', label: '冻结管理', icon: Lock, href: '/control-center/freeze', desc: '实体冻结/解冻' },
  { key: 'trust', label: '信任评分', icon: Shield, href: '/control-center/trust', desc: '多维度信任管理' },
  { key: 'timeline', label: '操作时间线', icon: Activity, href: '/control-center/timeline', desc: '全局审计追踪' },
  { key: 'dashboard', label: '大屏看板', icon: Monitor, href: '/control-center/dashboard', desc: '全屏数据展示' },
]

const severityColors = {
  critical: 'border-red-500 bg-red-50',
  warning: 'border-amber-500 bg-amber-50',
  info: 'border-blue-500 bg-blue-50',
}

const severityIcons = {
  critical: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

const severityTextColors = {
  critical: 'text-red-700',
  warning: 'text-amber-700',
  info: 'text-blue-700',
}

interface OverviewResponse {
  risk: {
    criticalFindings: number
    warningFindings: number
    activeFreezes: number
    lowTrustCount: number
    highRiskOrders: number
  }
  pending: {
    pendingApprovals: number
    pendingPayments: number
    blockedActions: number
    openRiskEvents: number
    closingPending: number
    closingTotal: number
    auditOpen: number
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
  }
  explanations: Explanation[]
}

export default function ControlCenterPage() {
  const { user, loading: userLoading } = useCurrentUser()
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/control-center/overview')
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading || userLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const role = user?.role || 'finance_staff'
  const config = ROLE_CONFIG[role] || ROLE_CONFIG.finance_staff
  const sections = config.sections
  const showSection = (key: string) => sections.includes(key)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Header title="AI 财务控制中心" subtitle="实时风险监控与智能决策辅助" />
        <Badge variant="outline" className="text-sm">
          <Sparkles className="h-3 w-3 mr-1" />
          {config.label}
        </Badge>
      </div>

      {data && (
        <div className="space-y-6">
          {/* Section 1: 最高风险 */}
          {showSection('risk') && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-red-500" />
                最高风险
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card className="border-l-4 border-l-red-500">
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">严重稽核发现</p>
                        <p className="text-3xl font-bold text-red-600">{data.risk.criticalFindings}</p>
                      </div>
                      <AlertCircle className="h-8 w-8 text-red-300" />
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-l-4 border-l-amber-500">
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">活跃冻结</p>
                        <p className="text-3xl font-bold text-amber-600">{data.risk.activeFreezes}</p>
                      </div>
                      <Snowflake className="h-8 w-8 text-amber-300" />
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-l-4 border-l-red-400">
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">低信任实体</p>
                        <p className="text-3xl font-bold text-red-500">{data.risk.lowTrustCount}</p>
                      </div>
                      <Shield className="h-8 w-8 text-red-200" />
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* Section 2: 待处理 */}
          {showSection('pending') && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Clock className="h-5 w-5 text-amber-500" />
                待处理
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                {[
                  { label: '待审批', value: data.pending.pendingApprovals, color: 'bg-blue-100 text-blue-800' },
                  { label: '待付款', value: data.pending.pendingPayments, color: 'bg-green-100 text-green-800' },
                  { label: '阻塞', value: data.pending.blockedActions, color: 'bg-red-100 text-red-800' },
                  { label: '风险', value: data.pending.openRiskEvents, color: 'bg-amber-100 text-amber-800' },
                  { label: '月结', value: `${data.pending.closingPending}/${data.pending.closingTotal}`, color: 'bg-purple-100 text-purple-800' },
                  { label: '稽核', value: data.pending.auditOpen, color: 'bg-orange-100 text-orange-800' },
                ].map(item => (
                  <Card key={item.label} className="text-center">
                    <CardContent className="pt-3 pb-3">
                      <p className="text-xs text-muted-foreground mb-1">{item.label}</p>
                      <Badge className={item.color + ' text-lg font-bold px-3 py-1'}>
                        {item.value}
                      </Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Section 3: 系统健康 */}
          {showSection('health') && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="h-5 w-5 text-blue-500" />
                系统健康
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className={`border-l-4 ${data.health.glBalanced ? 'border-l-green-500' : 'border-l-red-500'}`}>
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2">
                      {data.health.glBalanced
                        ? <CheckCircle className="h-5 w-5 text-green-500" />
                        : <XCircle className="h-5 w-5 text-red-500" />}
                      <div>
                        <p className="text-xs text-muted-foreground">GL平衡</p>
                        <p className={`text-sm font-semibold ${data.health.glBalanced ? 'text-green-600' : 'text-red-600'}`}>
                          {data.health.glBalanced ? '平衡' : '不平衡'}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-l-4 border-l-blue-500">
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2">
                      <Shield className="h-5 w-5 text-blue-500" />
                      <div>
                        <p className="text-xs text-muted-foreground">Trust均分</p>
                        <p className="text-sm font-semibold">{data.health.trustAvg}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-l-4 border-l-amber-500">
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5 text-amber-500" />
                      <div>
                        <p className="text-xs text-muted-foreground">回滚数</p>
                        <p className="text-sm font-semibold">{data.health.rollbackCount}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-l-4 border-l-red-500">
                  <CardContent className="pt-3 pb-3">
                    <div className="flex items-center gap-2">
                      <XCircle className="h-5 w-5 text-red-500" />
                      <div>
                        <p className="text-xs text-muted-foreground">拒绝数</p>
                        <p className="text-sm font-semibold">{data.health.rejectCount}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* Section 4: 趋势 */}
          {showSection('trends') && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-blue-500" />
                趋势
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className={`border-l-4 ${data.trends.profitTrend >= 0 ? 'border-l-green-500' : 'border-l-red-500'}`}>
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">利润环比趋势</p>
                        <div className="flex items-center gap-2 mt-1">
                          {data.trends.profitTrend >= 0
                            ? <TrendingUp className="h-5 w-5 text-green-500" />
                            : <TrendingDown className="h-5 w-5 text-red-500" />}
                          <span className={`text-2xl font-bold ${data.trends.profitTrend >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {data.trends.profitTrend >= 0 ? '+' : ''}{data.trends.profitTrend}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card className={`border-l-4 ${data.trends.trustDowngrades > 0 ? 'border-l-amber-500' : 'border-l-green-500'}`}>
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">信任降级 (7天)</p>
                        <p className={`text-2xl font-bold mt-1 ${data.trends.trustDowngrades > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                          {data.trends.trustDowngrades}
                        </p>
                      </div>
                      <Shield className="h-8 w-8 text-muted-foreground/30" />
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {/* Section 5: AI 解释 */}
          {showSection('explanation') && data.explanations.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-purple-500" />
                智能分析
              </h2>
              <div className="space-y-2">
                {data.explanations.map((exp, i) => {
                  const Icon = severityIcons[exp.severity]
                  return (
                    <Card key={i} className={`border-l-4 ${severityColors[exp.severity]}`}>
                      <CardContent className="pt-3 pb-3">
                        <div className="flex items-start gap-3">
                          <Icon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${severityTextColors[exp.severity]}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant="outline" className="text-xs">{exp.category}</Badge>
                            </div>
                            <p className={`text-sm ${severityTextColors[exp.severity]}`}>{exp.text}</p>
                          </div>
                          {exp.actionHref && (
                            <Link href={exp.actionHref} className="flex-shrink-0">
                              <ArrowRight className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
                            </Link>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 控制中心模块入口 */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">控制中心模块</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {MODULES.map(mod => (
            <Link key={mod.key} href={mod.href}>
              <Card className="hover:ring-2 hover:ring-primary/20 transition-all cursor-pointer h-full">
                <CardContent className="pt-4 pb-4 text-center">
                  <mod.icon className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm font-medium">{mod.label}</p>
                  <p className="text-xs text-muted-foreground mt-1">{mod.desc}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
