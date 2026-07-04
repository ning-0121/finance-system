// ============================================================
// 集成客户端 — 财务系统向节拍器发送审批结果
// ============================================================

import { generateSignature } from './security'
import type { ApprovalDecision, WebhookPayload } from './types'

const ORDER_METRONOME_URL = process.env.ORDER_METRONOME_URL || ''
const API_KEY = process.env.INTEGRATION_API_KEY || ''
const WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || ''

// --- 财务进度回传节拍器（审计 P1④：结算/收款/付款完成 → 让节拍器看到资金进度）---
export type FinanceProgressEvent = 'settlement.closed' | 'collection.received' | 'payment.completed'
export async function notifyFinanceProgress(
  event: FinanceProgressEvent,
  data: { qimo_order_id?: string | null; order_no?: string | null; internal_order_no?: string | null; amount?: number; currency?: string; note?: string; at?: string }
): Promise<{ success: boolean; error?: string }> {
  if (!ORDER_METRONOME_URL || !API_KEY) return { success: true }  // 未配置则静默跳过,绝不阻塞财务主流程
  const payload = {
    event,
    timestamp: new Date().toISOString(),
    source: 'finance-system' as const,
    request_id: `fin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    data: { ...data, at: data.at || new Date().toISOString() },
    signature: '',
  }
  const body = JSON.stringify(payload)
  payload.signature = generateSignature(body, WEBHOOK_SECRET)
  const signedBody = JSON.stringify(payload)
  try {
    const res = await fetch(`${ORDER_METRONOME_URL}/api/integration/finance-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'x-webhook-signature': generateSignature(signedBody, WEBHOOK_SECRET),
        'x-source': 'finance-system',
      },
      body: signedBody,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
    return { success: true }
  } catch (e) {
    return { success: false, error: `Network error: ${e instanceof Error ? e.message : 'unknown'}` }
  }
}

// --- 发送审批决定到节拍器 ---
export async function sendApprovalToMetronome(decision: ApprovalDecision): Promise<{
  success: boolean
  error?: string
}> {
  if (!ORDER_METRONOME_URL) {
    return { success: false, error: 'ORDER_METRONOME_URL not configured' }
  }

  const payload: WebhookPayload = {
    event: 'approval.callback',
    timestamp: new Date().toISOString(),
    source: 'finance-system',
    request_id: `fin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    data: decision as unknown as Record<string, unknown>,
    signature: '', // will be set below
  }

  const body = JSON.stringify(payload)
  payload.signature = generateSignature(body, WEBHOOK_SECRET)
  const signedBody = JSON.stringify(payload)

  try {
    const response = await fetch(`${ORDER_METRONOME_URL}/api/integration/finance-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'x-webhook-signature': generateSignature(signedBody, WEBHOOK_SECRET),
        'x-source': 'finance-system',
      },
      body: signedBody,
    })

    if (!response.ok) {
      const text = await response.text()
      return { success: false, error: `HTTP ${response.status}: ${text}` }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: `Network error: ${error instanceof Error ? error.message : 'unknown'}` }
  }
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
