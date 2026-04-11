'use client'

import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Plus, Edit, Snowflake, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import { toast } from 'sonner'

interface TimelineEvent { id: string; event_type: 'created' | 'updated' | 'frozen' | 'risk'; entity_type: string; entity_id: string; title: string; detail: string; actor: string; created_at: string }

const eventConfig = {
  created: { color: 'bg-green-500', textColor: 'text-green-700', label: '创建', icon: Plus },
  updated: { color: 'bg-blue-500', textColor: 'text-blue-700', label: '更新', icon: Edit },
  frozen: { color: 'bg-red-500', textColor: 'text-red-700', label: '冻结', icon: Snowflake },
  risk: { color: 'bg-amber-500', textColor: 'text-amber-700', label: '风险', icon: AlertTriangle },
}

export default function TimelinePage() {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [entityFilter, setEntityFilter] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/control-center/timeline')
      .then(r => r.json()).then(d => setEvents(d.events || []))
      .catch(() => toast.error('加载失败')).finally(() => setLoading(false))
  }, [])

  const toggle = (id: string) => setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const filtered = entityFilter === 'all' ? events : events.filter(e => e.entity_type === entityFilter)
  const entityTypes = [...new Set(events.map(e => e.entity_type))]

  return (
    <div className="flex flex-col h-full">
      <Header title="时间线" subtitle="实体事件追踪" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center gap-4">
          <Select value={entityFilter} onValueChange={v => setEntityFilter(v || 'all')}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="筛选类型" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部类型</SelectItem>
              {entityTypes.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{filtered.length} 条事件</span>
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">没有事件记录</div>
        ) : (
          <div className="relative">
            <div className="absolute left-5 top-0 bottom-0 w-px bg-border" />
            <div className="space-y-4">
              {filtered.map(ev => {
                const cfg = eventConfig[ev.event_type] || eventConfig.updated
                const Icon = cfg.icon
                const isOpen = expanded.has(ev.id)
                return (
                  <div key={ev.id} className="relative pl-12">
                    <div className={`absolute left-3 top-3 w-4 h-4 rounded-full ${cfg.color} flex items-center justify-center`}>
                      <Icon className="h-2.5 w-2.5 text-white" />
                    </div>
                    <Card className="cursor-pointer hover:shadow-sm" onClick={() => toggle(ev.id)}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant="outline" className={cfg.textColor}>{cfg.label}</Badge>
                              <Badge variant="outline">{ev.entity_type}</Badge>
                            </div>
                            <h4 className="text-sm font-medium">{ev.title}</h4>
                            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                              <span>{ev.actor}</span>
                              <span>{new Date(ev.created_at).toLocaleString('zh-CN')}</span>
                            </div>
                          </div>
                          {isOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                        </div>
                        {isOpen && ev.detail && (
                          <div className="mt-3 pt-3 border-t text-sm text-muted-foreground">{ev.detail}</div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
