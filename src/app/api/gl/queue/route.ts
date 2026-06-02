// POST /api/gl/queue — 业务事件入队 + 立即处理（默认仅生成 draft）
// GET  /api/gl/queue — 列出队列项（控制中心 / GL 复核页用）
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { enqueueAndProcess, type BusinessEvent } from '@/lib/accounting/gl-queue'

const VALID_EVENTS: BusinessEvent[] = ['order_approved', 'settlement_confirmed', 'receipt_saved', 'payment_registered']

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  try {
    const body = await request.json()
    const { businessEvent, sourceType, sourceId, bankCode, bankName } = body || {}
    if (!VALID_EVENTS.includes(businessEvent)) {
      return NextResponse.json({ error: `无效 businessEvent: ${businessEvent}` }, { status: 400 })
    }
    if (!sourceType || !sourceId) {
      return NextResponse.json({ error: '缺少 sourceType/sourceId' }, { status: 400 })
    }
    const { queueId, result } = await enqueueAndProcess({
      businessEvent, sourceType, sourceId, bankCode, bankName, createdBy: auth.userId,
    })
    // 入队/处理失败都返回 200：业务已成功，GL 异常已落异常中心，不阻塞业务
    return NextResponse.json({ success: true, queueId, result })
  } catch (error) {
    // 兜底：即便这里异常，也不应影响已完成的业务操作
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'GL入队失败' }, { status: 200 })
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  try {
    const supabase = await createClient()
    const status = request.nextUrl.searchParams.get('status')
    let q = supabase.from('gl_posting_queue').select('*').order('created_at', { ascending: false }).limit(200)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '查询失败' }, { status: 500 })
  }
}
