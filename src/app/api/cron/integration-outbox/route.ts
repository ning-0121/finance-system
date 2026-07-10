// ============================================================
// Cron API: /api/cron/integration-outbox
// 高频重试「财务→节拍器」回传 outbox(审计修 2026-07-09):
// 此前 retryFinanceOutbox 唯一由 orchestrate 触发、每天只跑一次(0 1 * * *),
// 审批回传首发失败最长滞后近 24h,已批准的采购单卡着不下单、无告警。
// 本路由每 15 分钟专跑 retryFinanceOutbox,与节拍器侧 processFinanceOutbox(*/15)节奏对齐。
// ============================================================

import { NextResponse } from 'next/server'
import { retryFinanceOutbox } from '@/lib/integration/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(request: Request) {
  // 与 orchestrate 同一鉴权口径:必须配置 CRON_SECRET,Bearer 校验,无 fallback 开放
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET 未配置，拒绝执行' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const r = await retryFinanceOutbox()
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'unknown' }, { status: 500 })
  }
}
