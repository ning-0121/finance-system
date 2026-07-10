// GET /api/integration/metronome-attachments?orderNo=QM-xxx
// F2(2026-07-11):财务订单详情页拉取「绮陌附件」。浏览器不持签名密钥→由本路由服务端签名代理调节拍器,
// 返回逐个即时签名 URL 的附件列表。只读、登录即可。
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { fetchOrderAttachmentsFromMetronome } from '@/lib/integration/client'

export async function GET(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const orderNo = new URL(request.url).searchParams.get('orderNo')?.trim()
  if (!orderNo) return NextResponse.json({ error: '缺少 orderNo' }, { status: 400 })
  const r = await fetchOrderAttachmentsFromMetronome(orderNo)
  if (!r.success) return NextResponse.json({ error: r.error || '拉取失败', data: [] }, { status: 200 })
  return NextResponse.json({ data: r.data || [] })
}
