// GET /api/integration/wecom-probe
// 企微/微盘连通性自诊断（x-api-key 鉴权）：验证 corp 凭据 + 微盘 API 权限。
// 只返回错误码/摘要，不回显任何密钥。
import { NextResponse } from 'next/server'
import { verifyApiKey } from '@/lib/integration/security'
import { getAccessToken } from '@/lib/wecom/client'

export async function GET(request: Request) {
  const apiKey = request.headers.get('x-api-key')
  if (!apiKey || !verifyApiKey(apiKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result: Record<string, unknown> = {
    corp_id_present: !!process.env.WECOM_CORP_ID,
    corp_secret_present: !!process.env.WECOM_CORP_SECRET,
    agent_id: process.env.WECOM_AGENT_ID || null,
  }

  try {
    const token = await getAccessToken()
    result.gettoken = 'ok'

    const cap = await (await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/wedrive/mng_capacity?access_token=${token}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
    )).json()
    result.wedrive_capacity = { errcode: cap.errcode, errmsg: String(cap.errmsg || '').slice(0, 100) }
    if (cap.errcode === 0) {
      result.wedrive = 'ok'
      result.capacity = { total_size: cap.total_size, used_size: cap.used_size }
    } else if (cap.errcode === 48002) {
      result.wedrive = 'forbidden — 企微后台未把本应用加入微盘可调用列表'
    } else {
      result.wedrive = `errcode ${cap.errcode}`
    }
  } catch (e) {
    result.gettoken = `failed: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`
  }

  return NextResponse.json(result)
}
