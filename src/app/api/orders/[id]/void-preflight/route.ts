// ============================================================
// GET /api/orders/[id]/void-preflight
// 订单作废「体检」(只读):扫这张预算单牵连的所有子数据,返回三级分级结果。
// 切片1 弹窗用它展示「删这单会牵连什么」,不做任何写操作。
// 用 service client 保证跨表读取一致(不受各表 RLS 差异影响);仅登录可访问。
// ============================================================
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { createServiceClient } from '@/lib/supabase/service'
import { preflightOrderVoid } from '@/lib/financial/order-void'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { id } = await params
  if (!id) return NextResponse.json({ error: '缺少订单 id' }, { status: 400 })

  try {
    const sb = createServiceClient()
    const report = await preflightOrderVoid(sb, id)
    return NextResponse.json(report)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '体检失败'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
