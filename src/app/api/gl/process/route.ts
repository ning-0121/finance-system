// POST /api/gl/process — 处理 pending + 到期重试的队列项（worker/cron 入口）
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { processPendingQueue } from '@/lib/accounting/gl-queue'

export async function POST() {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  try {
    const r = await processPendingQueue(50)
    return NextResponse.json({ success: true, ...r })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '处理失败' }, { status: 500 })
  }
}
