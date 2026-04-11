'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Shield, Snowflake, Clock } from 'lucide-react'

// Trust 等级颜色
const TRUST_LEVEL_CONFIG: Record<string, { color: string; bg: string }> = {
  T0: { color: 'text-red-700', bg: 'bg-red-100' },
  T1: { color: 'text-orange-700', bg: 'bg-orange-100' },
  T2: { color: 'text-amber-700', bg: 'bg-amber-100' },
  T3: { color: 'text-green-700', bg: 'bg-green-100' },
  T4: { color: 'text-blue-700', bg: 'bg-blue-100' },
  T5: { color: 'text-purple-700', bg: 'bg-purple-100' },
}

interface TrustData {
  currentScore: number
  currentLevel: string
  trend: string
}

interface FreezeRecord {
  entity_type: string
  entity_id: string
  entity_name: string
  status: string
  freeze_reason: string
  frozen_at: string
}

interface TimelineEvent {
  id: string
  event_title: string
  event_type: string
  created_at: string
  source_type: string | null
}

interface EntityContextProps {
  entityType: string
  entityId: string
}

export function EntityContext({ entityType, entityId }: EntityContextProps) {
  const [trust, setTrust] = useState<TrustData | null>(null)
  const [frozen, setFrozen] = useState(false)
  const [freezeReason, setFreezeReason] = useState('')
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        const [trustRes, freezeRes, timelineRes] = await Promise.all([
          fetch(`/api/control-center/trust?subjectType=${encodeURIComponent(entityType)}&subjectId=${encodeURIComponent(entityId)}`)
            .then(r => r.json())
            .catch(() => ({ data: null })),
          fetch(`/api/control-center/freeze?entityType=${encodeURIComponent(entityType)}`)
            .then(r => r.json())
            .catch(() => ({ data: [] })),
          fetch(`/api/control-center/timeline?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}&limit=10`)
            .then(r => r.json())
            .catch(() => ({ data: [] })),
        ])

        // Trust
        if (trustRes.data) {
          setTrust({
            currentScore: trustRes.data.currentScore ?? trustRes.data.totalScore ?? 50,
            currentLevel: trustRes.data.currentLevel ?? trustRes.data.trustLevel ?? 'T2',
            trend: trustRes.data.trend ?? 'stable',
          })
        }

        // Freeze — filter by entityId
        const freezes: FreezeRecord[] = (freezeRes.data || []).filter(
          (f: FreezeRecord) => f.entity_id === entityId && f.status === 'frozen'
        )
        if (freezes.length > 0) {
          setFrozen(true)
          setFreezeReason(freezes[0].freeze_reason || '')
        } else {
          setFrozen(false)
          setFreezeReason('')
        }

        // Timeline
        const events: TimelineEvent[] = timelineRes.data || timelineRes.events || []
        setTimeline(events.slice(0, 5))
      } catch {
        // Silently handle errors
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [entityType, entityId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">控制上下文</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    )
  }

  const levelConfig = trust ? TRUST_LEVEL_CONFIG[trust.currentLevel] || TRUST_LEVEL_CONFIG.T2 : TRUST_LEVEL_CONFIG.T2

  const trendLabels: Record<string, string> = {
    improving: '上升',
    declining: '下降',
    stable: '稳定',
  }
  const trendColors: Record<string, string> = {
    improving: 'text-green-600',
    declining: 'text-red-600',
    stable: 'text-gray-500',
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-4 w-4" />
          控制上下文
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Trust Badge */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">信任等级</p>
          <div className="flex items-center gap-3">
            {trust ? (
              <>
                <Badge className={`${levelConfig.bg} ${levelConfig.color} text-sm font-bold px-2.5 py-1`}>
                  {trust.currentLevel}
                </Badge>
                <span className="text-sm font-mono">{trust.currentScore} 分</span>
                <span className={`text-xs ${trendColors[trust.trend] || 'text-gray-500'}`}>
                  {trendLabels[trust.trend] || trust.trend}
                </span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">暂无评分</span>
            )}
          </div>
        </div>

        {/* Freeze Status */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium">冻结状态</p>
          <div className="flex items-center gap-2">
            {frozen ? (
              <>
                <Badge variant="destructive" className="flex items-center gap-1">
                  <Snowflake className="h-3 w-3" />
                  已冻结
                </Badge>
                {freezeReason && (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]" title={freezeReason}>
                    {freezeReason}
                  </span>
                )}
              </>
            ) : (
              <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50">
                正常
              </Badge>
            )}
          </div>
        </div>

        {/* Mini Timeline */}
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground font-medium flex items-center gap-1">
            <Clock className="h-3 w-3" />
            最近事件
          </p>
          {timeline.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">暂无事件记录</p>
          ) : (
            <div className="space-y-1.5">
              {timeline.map(evt => (
                <div key={evt.id} className="flex items-start gap-2">
                  <div className="w-1.5 h-1.5 mt-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-foreground truncate">{evt.event_title}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(evt.created_at).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
