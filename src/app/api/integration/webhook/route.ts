// ============================================================
// POST /api/integration/webhook
// 接收来自订单节拍器的 Webhook 事件
// 安全：API Key + HMAC签名 + 时间戳防重放 + 幂等性
// ============================================================

import { NextResponse } from 'next/server'
import {
  validateRequest,
  checkRateLimit,
  isRequestProcessed,
  markRequestProcessed,
} from '@/lib/integration/security'
import type { WebhookPayload, SyncedOrder, PriceApprovalRequest, DelayApprovalRequest } from '@/lib/integration/types'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: Request) {
  // 1. 速率限制
  const clientIp = request.headers.get('x-forwarded-for') || 'unknown'
  if (!checkRateLimit(clientIp, 120, 60_000)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }

  // 2. 安全验证（API Key + 签名 + 时间戳）
  const validation = await validateRequest(request)
  if (!validation.valid) {
    console.error(`[Webhook] Security validation failed: ${validation.error}`)
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    )
  }

  // 3. 解析事件
  let payload: WebhookPayload
  try {
    payload = JSON.parse(validation.body!)
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  // 4. 幂等性检查
  if (isRequestProcessed(payload.request_id)) {
    return NextResponse.json({ status: 'already_processed', request_id: payload.request_id })
  }

  // 5. 处理事件
  try {
    const result = await handleWebhookEvent(payload)
    markRequestProcessed(payload.request_id)

    // 6. 记录集成日志
    await logIntegrationEvent(payload, 'inbound', 'success')

    return NextResponse.json({
      status: 'ok',
      request_id: payload.request_id,
      result,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[Webhook] Processing error: ${errorMsg}`)
    await logIntegrationEvent(payload, 'inbound', 'failed', errorMsg)

    return NextResponse.json(
      { error: 'Processing failed', detail: errorMsg },
      { status: 500 }
    )
  }
}

// --- 事件处理路由 ---
async function handleWebhookEvent(payload: WebhookPayload) {
  switch (payload.event) {
    case 'order.created':
    case 'order.updated':
    case 'order.activated':
      return handleOrderSync(payload.data as unknown as SyncedOrder, payload.event)

    case 'order.completed':
    case 'order.cancelled':
      return handleOrderStatusChange(payload.data as unknown as SyncedOrder, payload.event)

    case 'price_approval.requested':
      return handlePriceApprovalRequest(payload.data as unknown as PriceApprovalRequest)

    case 'delay.requested':
      return handleDelayApprovalRequest(payload.data as unknown as DelayApprovalRequest)

    default:
      return { action: 'ignored', reason: `Unknown event type: ${payload.event}` }
  }
}

// --- 订单同步 ---
async function handleOrderSync(order: SyncedOrder, event: string) {
  const supabase = await createClient()

  // Upsert 同步订单
  const { error } = await supabase
    .from('synced_orders')
    .upsert({
      id: order.id,
      order_no: order.order_no,
      customer_name: order.customer_name,
      incoterm: order.incoterm,
      delivery_type: order.delivery_type,
      order_type: order.order_type,
      lifecycle_status: order.lifecycle_status,
      po_number: order.po_number,
      currency: order.currency,
      unit_price: order.unit_price,
      total_amount: order.total_amount,
      quantity: order.quantity,
      quantity_unit: order.quantity_unit,
      factory_name: order.factory_name,
      etd: order.etd,
      payment_terms: order.payment_terms,
      style_no: order.style_no,
      notes: order.notes,
      source_created_by: order.created_by,
      source_created_at: order.created_at,
      source_updated_at: order.updated_at,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) throw new Error(`Sync failed: ${error.message}`)
  return { action: 'synced', order_no: order.order_no, event }
}

// --- 订单状态变更 ---
async function handleOrderStatusChange(order: SyncedOrder, event: string) {
  const supabase = await createClient()

  const { error } = await supabase
    .from('synced_orders')
    .update({
      lifecycle_status: order.lifecycle_status,
      source_updated_at: order.updated_at,
      synced_at: new Date().toISOString(),
    })
    .eq('id', order.id)

  if (error) throw new Error(`Status update failed: ${error.message}`)
  return { action: 'status_updated', order_no: order.order_no, status: order.lifecycle_status, event }
}

// --- 价格审批请求 ---
async function handlePriceApprovalRequest(req: PriceApprovalRequest) {
  const supabase = await createClient()

  const { error } = await supabase
    .from('pending_approvals')
    .upsert({
      id: req.id,
      approval_type: 'price',
      order_no: req.order_no,
      customer_name: req.customer_name,
      requested_by_name: req.requester_name,
      summary: req.summary,
      detail: req.price_diffs,
      form_snapshot: req.form_snapshot,
      expires_at: req.expires_at,
      status: 'pending',
      source_created_at: req.created_at,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) throw new Error(`Price approval sync failed: ${error.message}`)
  return { action: 'approval_queued', type: 'price', order_no: req.order_no }
}

// --- 延期审批请求 ---
async function handleDelayApprovalRequest(req: DelayApprovalRequest) {
  const supabase = await createClient()

  const { error } = await supabase
    .from('pending_approvals')
    .upsert({
      id: req.id,
      approval_type: 'delay',
      order_no: req.order_no,
      customer_name: null,
      requested_by_name: req.requester_name,
      summary: `${req.milestone_name}: ${req.reason_type}`,
      detail: {
        milestone_name: req.milestone_name,
        reason_type: req.reason_type,
        reason_detail: req.reason_detail,
        reason_category: req.reason_category,
        proposed_new_date: req.proposed_new_date,
        current_due_date: req.current_due_date,
        requires_customer_approval: req.requires_customer_approval,
      },
      status: 'pending',
      source_created_at: req.created_at,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'id' })

  if (error) throw new Error(`Delay approval sync failed: ${error.message}`)
  return { action: 'approval_queued', type: 'delay', order_no: req.order_no }
}

// --- 记录集成日志 ---
async function logIntegrationEvent(
  payload: WebhookPayload,
  direction: 'inbound' | 'outbound',
  status: 'success' | 'failed',
  errorMessage?: string
) {
  try {
    const supabase = await createClient()
    await supabase.from('integration_logs').insert({
      event_type: payload.event,
      direction,
      request_id: payload.request_id,
      source: payload.source,
      status,
      payload_summary: JSON.stringify(payload.data).slice(0, 500),
      error_message: errorMessage || null,
    })
  } catch (e) {
    console.error('[Webhook] Failed to log event:', e)
  }
}
