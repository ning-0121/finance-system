'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, TrendingUp, TrendingDown, Target, Shield, RotateCcw, CheckCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

export default function AccuracyDashboardPage() {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({
    totalDocs: 0, confirmed: 0, rejected: 0, rolledBack: 0,
    avgClassificationConf: 0, humanModifiedRate: 0,
  })

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const { data: docs } = await supabase.from('uploaded_documents').select('status, doc_category_confidence, confirmation_changes')

        if (docs?.length) {
          const confirmed = docs.filter(d => d.status === 'confirmed').length
          const rejected = docs.filter(d => d.status === 'rejected').length
          const withChanges = docs.filter(d => d.confirmation_changes && Object.keys(d.confirmation_changes).length > 0).length
          const avgConf = docs.reduce((s, d) => s + ((d.doc_category_confidence || 0) * 100), 0) / (docs.length || 1)

          setStats({
            totalDocs: docs.length,
            confirmed,
            rejected,
            rolledBack: 0,
            avgClassificationConf: Math.round(avgConf),
            humanModifiedRate: docs.length > 0 ? Math.round((withChanges / docs.length) * 100) : 0,
          })
        }
      } catch { /* demo */ }
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  const confirmRate = stats.totalDocs > 0 ? Math.round((stats.confirmed / stats.totalDocs) * 100) : 0
  const rejectRate = stats.totalDocs > 0 ? Math.round((stats.rejected / stats.totalDocs) * 100) : 0

  // 演示趋势数据
  const trendData = [
    { period: '第1周', classification: 78, extraction: 72, execution: 85 },
    { period: '第2周', classification: 82, extraction: 76, execution: 88 },
    { period: '第3周', classification: 85, extraction: 80, execution: 90 },
    { period: '第4周', classification: 88, extraction: 83, execution: 92 },
  ]

  return (
    <div className="flex flex-col h-full">
      <Header title="准确率监控中心" subtitle="识别·匹配·执行·回滚 — 全链路可量化" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* KPI */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <Target className="h-5 w-5 mx-auto mb-1 text-blue-600" />
              <p className="text-2xl font-bold">{stats.avgClassificationConf}%</p>
              <p className="text-[10px] text-muted-foreground">分类准确率</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <CheckCircle className="h-5 w-5 mx-auto mb-1 text-green-600" />
              <p className="text-2xl font-bold">{confirmRate}%</p>
              <p className="text-[10px] text-muted-foreground">确认通过率</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <TrendingDown className="h-5 w-5 mx-auto mb-1 text-amber-600" />
              <p className="text-2xl font-bold">{stats.humanModifiedRate}%</p>
              <p className="text-[10px] text-muted-foreground">人工修改率</p>
              <p className="text-[9px] text-muted-foreground">(越低越好)</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <TrendingUp className="h-5 w-5 mx-auto mb-1 text-red-600" />
              <p className="text-2xl font-bold">{rejectRate}%</p>
              <p className="text-[10px] text-muted-foreground">驳回率</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <RotateCcw className="h-5 w-5 mx-auto mb-1 text-purple-600" />
              <p className="text-2xl font-bold">{stats.rolledBack}</p>
              <p className="text-[10px] text-muted-foreground">回滚次数</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <Shield className="h-5 w-5 mx-auto mb-1 text-green-600" />
              <p className="text-2xl font-bold">{stats.totalDocs}</p>
              <p className="text-[10px] text-muted-foreground">处理总数</p>
            </CardContent>
          </Card>
        </div>

        {/* 趋势图 */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">准确率趋势（周度）</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="period" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} domain={[60, 100]} tickFormatter={v => `${v}%`} />
                <Tooltip formatter={(value) => [`${value}%`, '']} />
                <Bar dataKey="classification" name="分类准确率" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="extraction" name="提取准确率" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="execution" name="执行成功率" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* 信任度说明 */}
        <Card className="border-green-200 bg-green-50/30">
          <CardContent className="p-4">
            <h3 className="font-semibold text-sm mb-2">系统信任度评估</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
              <div>
                <Badge className="bg-green-100 text-green-700 mb-1">可信赖</Badge>
                <p className="text-xs text-muted-foreground">分类准确率 &gt;85%，人工修改率 &lt;15%</p>
              </div>
              <div>
                <Badge className="bg-amber-100 text-amber-700 mb-1">需关注</Badge>
                <p className="text-xs text-muted-foreground">准确率70-85%或修改率15-30%</p>
              </div>
              <div>
                <Badge className="bg-red-100 text-red-700 mb-1">需改进</Badge>
                <p className="text-xs text-muted-foreground">准确率&lt;70%或修改率&gt;30%</p>
              </div>
              <div>
                <Badge variant="outline" className="mb-1">核心原则</Badge>
                <p className="text-xs text-muted-foreground">宁可保守不执行，也不允许错误数据入库</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
