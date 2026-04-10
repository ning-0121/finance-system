// ============================================================
// GET /api/integration/health
// 集成健康检查端点 — 节拍器可调用验证连通性
// ============================================================

import { NextResponse } from 'next/server'
import { verifyApiKey } from '@/lib/integration/security'

export async function GET(request: Request) {
  const apiKey = request.headers.get('x-api-key')

  if (apiKey && !verifyApiKey(apiKey)) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  return NextResponse.json({
    status: 'healthy',
    service: 'finance-system',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    capabilities: [
      'webhook.receive',
      'approval.callback',
      'order.sync',
    ],
  })
}
