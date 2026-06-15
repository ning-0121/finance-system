// ============================================================
// 可信度中心 API
// GET  ?history=30 → 最新一次巡检 + 近 N 次评分趋势
// POST            → 立即巡检（登录财务触发，使用用户会话身份）
// ============================================================
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { runIntegrityCheck } from '@/lib/engines/integrity-engine'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const supabase = await createClient()
  const url = new URL(request.url)
  const historyN = Math.min(90, Number(url.searchParams.get('history')) || 30)

  const [{ data: latest }, { data: history }] = await Promise.all([
    supabase.from('integrity_runs').select('*').order('run_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('integrity_runs').select('run_at, score, critical_count, warning_count, trigger')
      .order('run_at', { ascending: false }).limit(historyN),
  ])
  return NextResponse.json({ latest: latest || null, history: (history || []).reverse() })
}

export async function POST() {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  try {
    const supabase = await createClient()
    const result = await runIntegrityCheck(supabase, 'manual')
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : '巡检失败' }, { status: 500 })
  }
}
