import { NextResponse } from 'next/server'

export async function GET() {
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
