// ============================================================
// 集成客户端 — 财务系统向节拍器发送审批结果
// ============================================================

import { generateSignature } from './security'
import type { ApprovalDecision, WebhookPayload } from './types'

const ORDER_METRONOME_URL = process.env.ORDER_METRONOME_URL || ''
const API_KEY = process.env.INTEGRATION_API_KEY || ''
const WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || ''

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
