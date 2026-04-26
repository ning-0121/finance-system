// ============================================================
// API 安全层 — HMAC签名验证 + 速率限制 + 请求幂等性
// ============================================================

import { createHmac, timingSafeEqual } from 'crypto'

const WEBHOOK_SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || ''
const API_KEY = process.env.INTEGRATION_API_KEY || ''

// 允许的来源域名（Vercel 部署不固定 IP，用域名 + 签名双重验证）
// 支持环境变量 INTEGRATION_ALLOWED_ORIGINS 逗号分隔多个域名；
// 老变量 ORDER_METRONOME_URL 仍向后兼容。
// 注意：当前 validateRequest() 并未强制调用 verifyOrigin，
// 真正的鉴权依赖 API Key + HMAC 签名 + 时间戳。此白名单仅供未来启用。
const DEFAULT_ALLOWED_ORIGINS = [
  'https://order.qimoactivewear.com',     // 订单节拍器自定义域名
  'https://order-metronome.vercel.app',   // 订单节拍器 Vercel 默认域名
]

const ALLOWED_ORIGINS: string[] = (() => {
  const fromEnv = process.env.INTEGRATION_ALLOWED_ORIGINS
  if (fromEnv) {
    return fromEnv.split(',').map(s => s.trim()).filter(Boolean)
  }
  const legacy = process.env.ORDER_METRONOME_URL
  return legacy ? [...new Set([legacy, ...DEFAULT_ALLOWED_ORIGINS])] : DEFAULT_ALLOWED_ORIGINS
})()

// --- HMAC-SHA256 签名生成 ---
export function generateSignature(payload: string, secret?: string): string {
  return createHmac('sha256', secret || WEBHOOK_SECRET)
    .update(payload)
    .digest('hex')
}

// --- HMAC-SHA256 签名验证（恒定时间比较，防时序攻击） ---
export function verifySignature(payload: string, signature: string, secret?: string): boolean {
  if (!WEBHOOK_SECRET && !secret) return false
  const expected = generateSignature(payload, secret)
  try {
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    )
  } catch {
    return false
  }
}

// --- API Key 验证 ---
export function verifyApiKey(key: string): boolean {
  if (!API_KEY) return false
  try {
    return timingSafeEqual(
      Buffer.from(key),
      Buffer.from(API_KEY)
    )
  } catch {
    return false
  }
}

// --- 来源验证 ---
export function verifyOrigin(origin: string | null): boolean {
  if (!origin) return false
  return ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))
}

// --- 请求验证中间件（综合验证） ---
export async function validateRequest(request: Request): Promise<{
  valid: boolean
  error?: string
  body?: string
}> {
  // 1. API Key 验证
  const apiKey = request.headers.get('x-api-key')
  if (!apiKey || !verifyApiKey(apiKey)) {
    return { valid: false, error: 'Invalid API key' }
  }

  // 2. 读取请求体
  const body = await request.text()
  if (!body) {
    return { valid: false, error: 'Empty request body' }
  }

  // 3. 签名验证
  const signature = request.headers.get('x-webhook-signature')
  if (!signature || !verifySignature(body, signature)) {
    return { valid: false, error: 'Invalid signature' }
  }

  // 4. 时间戳检查（防重放攻击，5分钟窗口）
  try {
    const payload = JSON.parse(body)
    if (payload.timestamp) {
      const requestTime = new Date(payload.timestamp).getTime()
      const now = Date.now()
      const fiveMinutes = 5 * 60 * 1000
      if (Math.abs(now - requestTime) > fiveMinutes) {
        return { valid: false, error: 'Request expired (replay attack prevention)' }
      }
    }
  } catch {
    return { valid: false, error: 'Invalid JSON payload' }
  }

  return { valid: true, body }
}

// --- 简单内存速率限制 ---
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

export function checkRateLimit(
  key: string,
  maxRequests: number = 60,
  windowMs: number = 60_000
): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }

  if (entry.count >= maxRequests) {
    return false
  }

  entry.count++
  return true
}

// --- 幂等性检查（防重复处理） ---
const processedRequests = new Map<string, number>()

export function isRequestProcessed(requestId: string): boolean {
  const timestamp = processedRequests.get(requestId)
  if (timestamp) {
    // 1小时内的重复请求拒绝
    if (Date.now() - timestamp < 3600_000) return true
    processedRequests.delete(requestId)
  }
  return false
}

export function markRequestProcessed(requestId: string): void {
  processedRequests.set(requestId, Date.now())

  // 清理超过1小时的记录
  if (processedRequests.size > 10000) {
    const cutoff = Date.now() - 3600_000
    for (const [id, ts] of processedRequests) {
      if (ts < cutoff) processedRequests.delete(id)
    }
  }
}
