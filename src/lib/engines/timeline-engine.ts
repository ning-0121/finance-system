// ============================================================
// Timeline Engine — 通用实体时间线 / 审计追踪
// ============================================================

import { createClient } from '@/lib/supabase/client'

// --------------- Types ---------------

export interface TimelineEvent {
  id: string
  entity_type: string
  entity_id: string
  event_type: string
  event_title: string
  event_detail: Record<string, unknown> | null
  field_changes: Record<string, { from: unknown; to: unknown }> | null
  source_type: 'user' | 'agent' | 'system' | 'document_engine' | 'import' | 'api' | null
  source_id: string | null
  actor_id: string | null
  actor_name: string | null
  created_at: string
}

// --------------- Record a timeline event ---------------

export async function recordTimelineEvent(params: {
  entityType: string
  entityId: string
  eventType: string
  eventTitle: string
  eventDetail?: Record<string, unknown>
  fieldChanges?: Record<string, { from: unknown; to: unknown }>
  sourceType?: 'user' | 'agent' | 'system' | 'document_engine' | 'import' | 'api'
  sourceId?: string
  actorId?: string
  actorName?: string
}): Promise<void> {
  const supabase = createClient()

  const { error } = await supabase.from('entity_timeline').insert({
    entity_type: params.entityType,
    entity_id: params.entityId,
    event_type: params.eventType,
    event_title: params.eventTitle,
    event_detail: params.eventDetail ?? null,
    field_changes: params.fieldChanges
      ? Object.fromEntries(
          Object.entries(params.fieldChanges).map(([k, v]) => [k, v])
        )
      : null,
    source_type: params.sourceType ?? null,
    source_id: params.sourceId ?? null,
    actor_id: params.actorId ?? null,
    actor_name: params.actorName ?? null,
  })

  if (error) {
    console.error('[timeline-engine] recordTimelineEvent failed:', error.message)
    throw new Error(`Failed to record timeline event: ${error.message}`)
  }
}

// --------------- Get timeline for a specific entity ---------------

export async function getEntityTimeline(
  entityType: string,
  entityId: string,
  options?: {
    limit?: number
    offset?: number
    eventTypes?: string[]
  }
): Promise<TimelineEvent[]> {
  const supabase = createClient()
  const limit = options?.limit ?? 50
  const offset = options?.offset ?? 0

  let query = supabase
    .from('entity_timeline')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (options?.eventTypes && options.eventTypes.length > 0) {
    query = query.in('event_type', options.eventTypes)
  }

  const { data, error } = await query

  if (error) {
    console.error('[timeline-engine] getEntityTimeline failed:', error.message)
    return []
  }

  return (data ?? []) as TimelineEvent[]
}

// --------------- Get recent events across all entities ---------------

export async function getRecentEvents(limit: number = 20): Promise<TimelineEvent[]> {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('entity_timeline')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[timeline-engine] getRecentEvents failed:', error.message)
    return []
  }

  return (data ?? []) as TimelineEvent[]
}
