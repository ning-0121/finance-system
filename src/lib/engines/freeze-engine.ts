// ============================================================
// Freeze Engine — 实体冻结 / 解冻管理
// 与 circuit-breaker 集成，每次操作写入 timeline
// ============================================================

import { createClient } from '@/lib/supabase/client'
import { recordTimelineEvent } from './timeline-engine'

// --------------- Types ---------------

export interface FreezeRecord {
  id: string
  entity_type: string
  entity_id: string
  entity_name: string
  freeze_reason: string
  freeze_type: 'manual' | 'auto_breaker' | 'auto_audit' | 'auto_trust'
  trigger_source: string | null
  status: 'frozen' | 'unfrozen'
  frozen_by: string | null
  frozen_at: string
  unfreeze_requested_by: string | null
  unfreeze_requested_at: string | null
  unfrozen_by: string | null
  unfrozen_at: string | null
  unfreeze_reason: string | null
  created_at: string
}

// --------------- Freeze an entity ---------------

export async function freezeEntity(params: {
  entityType: string
  entityId: string
  entityName: string
  reason: string
  freezeType: 'manual' | 'auto_breaker' | 'auto_audit' | 'auto_trust'
  triggerSource?: string
  frozenBy?: string
}): Promise<{ success: boolean; freezeId?: string; error?: string }> {
  const supabase = createClient()

  // Check if already frozen
  const { data: existing } = await supabase
    .from('entity_freezes')
    .select('id')
    .eq('entity_type', params.entityType)
    .eq('entity_id', params.entityId)
    .eq('status', 'frozen')
    .maybeSingle()

  if (existing) {
    return {
      success: false,
      error: `${params.entityType}:${params.entityId} is already frozen (freeze id: ${existing.id})`,
    }
  }

  const { data, error } = await supabase
    .from('entity_freezes')
    .insert({
      entity_type: params.entityType,
      entity_id: params.entityId,
      entity_name: params.entityName,
      freeze_reason: params.reason,
      freeze_type: params.freezeType,
      trigger_source: params.triggerSource ?? null,
      frozen_by: params.frozenBy ?? null,
      status: 'frozen',
      frozen_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) {
    console.error('[freeze-engine] freezeEntity failed:', error.message)
    return { success: false, error: error.message }
  }

  // Record in timeline
  await recordTimelineEvent({
    entityType: params.entityType,
    entityId: params.entityId,
    eventType: 'entity_frozen',
    eventTitle: `${params.entityName} 被冻结`,
    eventDetail: {
      freeze_id: data.id,
      reason: params.reason,
      freeze_type: params.freezeType,
      trigger_source: params.triggerSource ?? null,
    },
    sourceType: params.freezeType === 'manual' ? 'user' : 'system',
    actorId: params.frozenBy,
    actorName: params.freezeType === 'manual' ? undefined : params.freezeType,
  })

  return { success: true, freezeId: data.id }
}

// --------------- Check if entity is frozen ---------------

export async function isEntityFrozen(
  entityType: string,
  entityId: string
): Promise<{ frozen: boolean; freeze?: Record<string, unknown> }> {
  const supabase = createClient()

  const { data, error } = await supabase
    .from('entity_freezes')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .eq('status', 'frozen')
    .order('frozen_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) {
    return { frozen: false }
  }

  return { frozen: true, freeze: data as Record<string, unknown> }
}

// --------------- Request unfreeze (needs separate approval) ---------------

export async function requestUnfreeze(
  freezeId: string,
  requestedBy: string,
  reason: string
): Promise<void> {
  const supabase = createClient()

  // Get the freeze record first
  const { data: freeze, error: fetchError } = await supabase
    .from('entity_freezes')
    .select('*')
    .eq('id', freezeId)
    .single()

  if (fetchError || !freeze) {
    throw new Error(`Freeze record not found: ${freezeId}`)
  }

  if (freeze.status !== 'frozen') {
    throw new Error(`Entity is not currently frozen (status: ${freeze.status})`)
  }

  const { error } = await supabase
    .from('entity_freezes')
    .update({
      unfreeze_requested_by: requestedBy,
      unfreeze_requested_at: new Date().toISOString(),
      unfreeze_reason: reason,
    })
    .eq('id', freezeId)

  if (error) {
    throw new Error(`Failed to request unfreeze: ${error.message}`)
  }

  await recordTimelineEvent({
    entityType: freeze.entity_type,
    entityId: freeze.entity_id,
    eventType: 'unfreeze_requested',
    eventTitle: `${freeze.entity_name} 请求解冻`,
    eventDetail: {
      freeze_id: freezeId,
      reason,
      requested_by: requestedBy,
    },
    sourceType: 'user',
    actorId: requestedBy,
  })
}

// --------------- Approve unfreeze ---------------

export async function approveUnfreeze(
  freezeId: string,
  approvedBy: string
): Promise<void> {
  const supabase = createClient()

  const { data: freeze, error: fetchError } = await supabase
    .from('entity_freezes')
    .select('*')
    .eq('id', freezeId)
    .single()

  if (fetchError || !freeze) {
    throw new Error(`Freeze record not found: ${freezeId}`)
  }

  if (freeze.status !== 'frozen') {
    throw new Error(`Entity is not currently frozen (status: ${freeze.status})`)
  }

  if (!freeze.unfreeze_requested_by) {
    throw new Error('No unfreeze request has been submitted for this freeze')
  }

  const { error } = await supabase
    .from('entity_freezes')
    .update({
      status: 'unfrozen',
      unfrozen_by: approvedBy,
      unfrozen_at: new Date().toISOString(),
    })
    .eq('id', freezeId)

  if (error) {
    throw new Error(`Failed to approve unfreeze: ${error.message}`)
  }

  await recordTimelineEvent({
    entityType: freeze.entity_type,
    entityId: freeze.entity_id,
    eventType: 'entity_unfrozen',
    eventTitle: `${freeze.entity_name} 已解冻`,
    eventDetail: {
      freeze_id: freezeId,
      original_reason: freeze.freeze_reason,
      unfreeze_reason: freeze.unfreeze_reason,
      approved_by: approvedBy,
      frozen_duration_hours: Math.round(
        (Date.now() - new Date(freeze.frozen_at).getTime()) / (1000 * 60 * 60)
      ),
    },
    sourceType: 'user',
    actorId: approvedBy,
  })
}

// --------------- Get all active freezes ---------------

export async function getActiveFreezes(
  entityType?: string
): Promise<Record<string, unknown>[]> {
  const supabase = createClient()

  let query = supabase
    .from('entity_freezes')
    .select('*')
    .eq('status', 'frozen')
    .order('frozen_at', { ascending: false })

  if (entityType) {
    query = query.eq('entity_type', entityType)
  }

  const { data, error } = await query

  if (error) {
    console.error('[freeze-engine] getActiveFreezes failed:', error.message)
    return []
  }

  return (data ?? []) as Record<string, unknown>[]
}
