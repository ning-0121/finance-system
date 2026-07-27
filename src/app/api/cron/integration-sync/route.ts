// ============================================================
// Cron API: /api/cron/integration-sync
// 定时全量对账兜底(审计 2026-07-27):webhook 漏投 / 断链期发生的订单变更此前只能靠
// 人工点订单页「同步」自愈,无任何定时对账 → 可能长期滞留旧值/漏建。
// 本路由低频触发既有 /api/integration/sync(x-api-key 机器通道,createdBy=null)做全量拉取对账:
// 补齐漏同步的订单 + 自愈缺失草稿 + 全字段重刷。sync 端点幂等(upsert + 原子认领),重复跑安全。
// ============================================================
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  // 与其它 cron 同一鉴权口径:必须配置 CRON_SECRET,Bearer 校验,无 fallback 开放
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET 未配置，拒绝执行' }, { status: 500 })
  }
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // 触发既有 sync 端点(x-api-key = 机器通道,sync 内部 createdBy 记 null,不冒用登录人)。
    // 用 cron 请求的 host 构造绝对 URL → 始终打到同一部署,无需硬编码域名。
    const url = new URL('/api/integration/sync', request.url)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-api-key': process.env.INTEGRATION_API_KEY || '' },
    })
    const sync = await res.json().catch(() => ({}))
    return NextResponse.json({ ok: res.ok, sync })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'unknown' }, { status: 500 })
  }
}
