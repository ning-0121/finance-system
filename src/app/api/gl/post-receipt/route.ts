// ============================================================
// POST /api/gl/post-receipt  { orderId }
// 应收收款后同步收款凭证（增量，借 银行 / 贷 应收）。
// 幂等：postOrderReceiptSync 只过账「累计收款 − 已过账」的差额。
// 非阻塞：收款信息已先行保存，本路由失败只影响 GL。
// ============================================================
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { postOrderReceiptSync } from '@/lib/accounting/gl-posting'

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const { orderId } = await request.json()
    if (!orderId) return NextResponse.json({ error: '缺少 orderId' }, { status: 400 })
    const result = await postOrderReceiptSync(orderId)
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : '过账失败' }, { status: 500 })
  }
}
