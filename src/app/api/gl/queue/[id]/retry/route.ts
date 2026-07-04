// POST /api/gl/queue/[id]/retry — 手动重试失败的过账队列项
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { retryQueueItem } from '@/lib/accounting/gl-queue'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  // 审计 P0:重试过账会触发真过账,仅 admin/财务经理
  const roleErr = requireRole(auth, ['admin', 'finance_manager'])
  if (roleErr) return roleErr
  try {
    const { id } = await params
    const result = await retryQueueItem(id, auth.userId)
    return NextResponse.json({ success: result.status !== 'failed', result })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '重试失败' }, { status: 500 })
  }
}
