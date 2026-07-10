// ============================================================
// 集成客户端 — 财务系统向节拍器发送审批结果
// ============================================================

import { generateSignature } from './security'
import type { ApprovalDecision, WebhookPayload } from './types'
import { createServiceClient } from '@/lib/supabase/service'

const ORDER_METRONOME_URL = process.env.ORDER_METRONOME_URL || ''
const API_KEY = process.env.INTEGRATION_API_KEY || ''
const WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || ''

// 确定性 request_id(内容键)—— 首发与重试同键,节拍器按 request_id 幂等去重(审计P1:替代随机键)
function detId(prefix: string, parts: (string | number | null | undefined)[]): string {
  const raw = `fin-${prefix}-${parts.map(p => String(p ?? '')).join('-')}`
  return raw.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120)
}

// 低层:对已定 request_id 的 payload 签名并投递到节拍器 finance-callback
async function postMetronomeCallback(event: string, requestId: string, data: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  if (!ORDER_METRONOME_URL || !API_KEY) return { success: true }   // 未配置则静默跳过,绝不阻塞主流程
  const payload: WebhookPayload = {
    event: event as WebhookPayload['event'], timestamp: new Date().toISOString(),
    source: 'finance-system', request_id: requestId, data, signature: '',
  }
  const body = JSON.stringify(payload)
  payload.signature = generateSignature(body, WEBHOOK_SECRET)
  const signedBody = JSON.stringify(payload)
  try {
    const res = await fetch(`${ORDER_METRONOME_URL}/api/integration/finance-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': API_KEY,
        'x-webhook-signature': generateSignature(signedBody, WEBHOOK_SECRET), 'x-source': 'finance-system',
      },
      body: signedBody, signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
    return { success: true }
  } catch (e) {
    return { success: false, error: `Network error: ${e instanceof Error ? e.message : 'unknown'}` }
  }
}

// 首发失败 → 落发件箱待 cron 退避重试(不再静默丢)
async function enqueueOutbox(event: string, requestId: string, data: Record<string, unknown>, error?: string) {
  try {
    await (createServiceClient().from('fin_outbound_outbox') as unknown as { upsert: (v: unknown, o: unknown) => Promise<unknown> }).upsert({
      target: 'metronome', event, request_id: requestId, payload: data, status: 'failed', attempts: 1,
      last_error: (error || '').slice(0, 500), next_retry_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    }, { onConflict: 'request_id', ignoreDuplicates: true })
  } catch (e) {
    console.error('[Integration] outbox 入队失败:', e instanceof Error ? e.message : e)
  }
}

// --- 财务进度回传节拍器（审计 P1④：结算/收款/付款完成 → 让节拍器看到资金进度）---
export type FinanceProgressEvent = 'settlement.closed' | 'collection.received' | 'payment.completed'
export async function notifyFinanceProgress(
  event: FinanceProgressEvent,
  data: { qimo_order_id?: string | null; order_no?: string | null; internal_order_no?: string | null; amount?: number; currency?: string; note?: string; at?: string }
): Promise<{ success: boolean; error?: string }> {
  const payload = { ...data, at: data.at || new Date().toISOString() }
  const requestId = detId(event, [data.qimo_order_id || data.order_no, data.amount, data.currency])
  const r = await postMetronomeCallback(event, requestId, payload)
  if (!r.success) {
    console.error(`[Integration] ${event} 回传失败(${r.error}) → 落 outbox 待重试`)
    await enqueueOutbox(event, requestId, payload, r.error)
  }
  return r
}

// --- 发送审批决定到节拍器 ---
export async function sendApprovalToMetronome(decision: ApprovalDecision): Promise<{ success: boolean; error?: string }> {
  const requestId = detId('approval', [decision.approval_type, decision.approval_id, decision.decision])
  const r = await postMetronomeCallback('approval.callback', requestId, decision as unknown as Record<string, unknown>)
  if (!r.success) {
    console.error(`[Integration] approval.callback(${decision.approval_type}/${decision.approval_id}) 回传失败(${r.error}) → 落 outbox 待重试`)
    await enqueueOutbox('approval.callback', requestId, decision as unknown as Record<string, unknown>, r.error)
  }
  return r
}

// --- cron 调用:退避重试 outbox 里失败的回传;超上限置 dead(可见待人工) ---
const OUTBOX_MAX_ATTEMPTS = 8
type OutboxRow = { id: string; event: string; payload: Record<string, unknown>; request_id: string; attempts: number }
export async function retryFinanceOutbox(): Promise<{ due: number; sent: number; dead: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = createServiceClient() as any
  const nowIso = new Date().toISOString()
  const { data: due } = await svc.from('fin_outbound_outbox')
    .select('id, event, payload, request_id, attempts').eq('status', 'failed').lt('attempts', OUTBOX_MAX_ATTEMPTS)
    .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`).limit(50)
  const rows: OutboxRow[] = (due || []) as OutboxRow[]
  let sent = 0, dead = 0
  for (const row of rows) {
    const r = await postMetronomeCallback(row.event, row.request_id, row.payload)
    if (r.success) {
      await svc.from('fin_outbound_outbox').update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null }).eq('id', row.id); sent++
    } else {
      const attempts = Number(row.attempts) + 1
      const status = attempts >= OUTBOX_MAX_ATTEMPTS ? 'dead' : 'failed'
      await svc.from('fin_outbound_outbox').update({ status, attempts, last_error: (r.error || '').slice(0, 500),
        next_retry_at: new Date(Date.now() + Math.min(2 ** attempts, 720) * 60_000).toISOString() }).eq('id', row.id)
      if (status === 'dead') dead++
    }
  }
  // 死信告警(修 P3 2026-07-09):回传耗尽转 dead 后此前只计数、无告警 → 审批回写永久失败无人知。
  // 推企微群,提醒人工处理。fire-and-forget,不阻断。
  if (dead > 0) {
    try {
      const { sendGroupText } = await import('@/lib/wecom/robot')
      await sendGroupText(`⛔ 财务→节拍器回传有 ${dead} 条重试耗尽转 dead、不再自动重投(审批批复可能没写回节拍器)。请查 fin_outbound_outbox status='dead' 人工重推。`)
    } catch (e) { console.error('[retryFinanceOutbox] dead 告警失败:', e instanceof Error ? e.message : e) }
  }
  return { due: rows.length, sent, dead }
}

// --- 签名拉取节拍器订单列表（P0-1：替代直连 Supabase 的合规通道）---
// 单页。鉴权与单查 /orders/{orderNo} 同套：x-api-key + HMAC(GET:orders:timestamp) + 时间戳窗口。
// 节拍器侧需提供 GET /api/integration/orders?updated_since&limit&offset（只读，返回同一批字段）。
export async function fetchOrdersFromMetronome(opts: { updatedSince?: string; limit?: number; offset?: number } = {}): Promise<{
  success: boolean
  data?: Record<string, unknown>[]
  error?: string
}> {
  if (!ORDER_METRONOME_URL) return { success: false, error: 'ORDER_METRONOME_URL not configured' }
  const { updatedSince, limit = 200, offset = 0 } = opts
  try {
    const timestamp = new Date().toISOString()
    const signature = generateSignature(`GET:orders:${timestamp}`, WEBHOOK_SECRET)
    const qs = new URLSearchParams()
    if (updatedSince) qs.set('updated_since', updatedSince)
    qs.set('limit', String(limit))
    qs.set('offset', String(offset))
    const response = await fetch(`${ORDER_METRONOME_URL}/api/integration/orders?${qs.toString()}`, {
      headers: {
        'x-api-key': API_KEY,
        'x-webhook-signature': signature,
        'x-timestamp': timestamp,
        'x-source': 'finance-system',
      },
    })
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` }
    const json = await response.json()
    // 兼容 {data:[...]} / {orders:[...]} / [...]
    const data = Array.isArray(json) ? json : (json.data || json.orders || [])
    return { success: true, data: data as Record<string, unknown>[] }
  } catch (error) {
    return { success: false, error: `Network error: ${error instanceof Error ? error.message : 'unknown'}` }
  }
}

// --- 分页拉全量（循环 fetchOrdersFromMetronome 直到取尽）---
export async function fetchAllOrdersFromMetronome(updatedSince?: string): Promise<{
  success: boolean
  data?: Record<string, unknown>[]
  error?: string
}> {
  const all: Record<string, unknown>[] = []
  const limit = 200
  for (let offset = 0; offset <= 100_000; offset += limit) {
    const r = await fetchOrdersFromMetronome({ updatedSince, limit, offset })
    if (!r.success) return { success: false, error: r.error }
    const batch = r.data || []
    all.push(...batch)
    if (batch.length < limit) break
  }
  return { success: true, data: all }
}

// --- 查询节拍器订单详情 ---
export async function fetchOrderFromMetronome(orderNo: string): Promise<{
  success: boolean
  data?: Record<string, unknown>
  error?: string
}> {
  if (!ORDER_METRONOME_URL) {
    return { success: false, error: 'ORDER_METRONOME_URL not configured' }
  }

  try {
    const timestamp = new Date().toISOString()
    const signPayload = `GET:${orderNo}:${timestamp}`
    const signature = generateSignature(signPayload, WEBHOOK_SECRET)

    const response = await fetch(`${ORDER_METRONOME_URL}/api/integration/orders/${encodeURIComponent(orderNo)}`, {
      headers: {
        'x-api-key': API_KEY,
        'x-webhook-signature': signature,
        'x-timestamp': timestamp,
        'x-source': 'finance-system',
      },
    })

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` }
    }

    const data = await response.json()
    return { success: true, data }
  } catch (error) {
    return { success: false, error: `Network error: ${error instanceof Error ? error.message : 'unknown'}` }
  }
}
