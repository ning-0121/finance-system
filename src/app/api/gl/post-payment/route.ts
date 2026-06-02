// ============================================================
// POST /api/gl/post-payment  { paymentId }
// 供应商付款登记后过账（借 应付账款 / 贷 银行存款）。
// 幂等：postSupplierPayment 按 (supplier_payment, paymentId) 自检。
// 非阻塞：付款记录已先行保存，本路由失败只影响 GL。
// ============================================================
import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { postSupplierPayment } from '@/lib/accounting/gl-posting'

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const { paymentId } = await request.json()
    if (!paymentId) return NextResponse.json({ error: '缺少 paymentId' }, { status: 400 })
    const result = await postSupplierPayment(paymentId)
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : '过账失败' }, { status: 500 })
  }
}
