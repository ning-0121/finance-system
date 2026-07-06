// ============================================================
// GET /api/auth/sso?token=<b64payload>.<hmac>&redirect=/dashboard
// 跨系统单点登录接收端:节拍器登录的财务人 → 带签名令牌跳转到此 → 建财务会话落地。
//
// 安全:HMAC(共享密钥 INTEGRATION_WEBHOOK_SECRET) + 2 分钟过期 + nonce 单次(防重放)
//   + email 必须已是财务账号(陌生 email 拒绝,需管理员先建号)。不共享 Supabase 会话,
//   只是一次签名握手 → 财务侧用 admin generateLink+verifyOtp 自建本系统会话。
// 财务系统自己的网址 + 账号密码登录不受影响(本路由是附加入口)。
// ============================================================
import { NextResponse, type NextRequest } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { createServerClient } from '@supabase/ssr'
import { createServiceClient } from '@/lib/supabase/service'

const SECRET = process.env.INTEGRATION_WEBHOOK_SECRET || ''

interface SsoPayload { email?: string; name?: string; role?: string; iss?: string; exp?: number; nonce?: string }

function verifyToken(token: string): { ok: boolean; payload?: SsoPayload; error?: string } {
  const dot = token.lastIndexOf('.')
  if (dot < 1) return { ok: false, error: 'format' }
  const b64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = createHmac('sha256', SECRET).update(b64).digest('hex')
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return { ok: false, error: 'sig' }
  } catch { return { ok: false, error: 'sig' } }
  try {
    return { ok: true, payload: JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as SsoPayload }
  } catch { return { ok: false, error: 'parse' } }
}

export async function GET(request: NextRequest) {
  const fail = (err: string) => NextResponse.redirect(new URL(`/login?sso_error=${err}`, request.url))
  if (!SECRET) return fail('not_configured')

  const token = request.nextUrl.searchParams.get('token')
  // 只允许站内相对路径,防开放重定向
  const rawRedirect = request.nextUrl.searchParams.get('redirect') || '/dashboard'
  const redirectTo = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') ? rawRedirect : '/dashboard'
  if (!token) return fail('no_token')

  const v = verifyToken(token)
  if (!v.ok || !v.payload) return fail('bad_token')
  const p = v.payload
  if (p.iss !== 'order-metronome') return fail('bad_issuer')
  if (!p.exp || Date.now() > Number(p.exp)) return fail('expired')
  const email = String(p.email || '').toLowerCase().trim()
  const nonce = String(p.nonce || '')
  if (!email) return fail('no_email')
  if (!nonce) return fail('no_nonce')

  const svc = createServiceClient()

  // 1. nonce 单次:插入,唯一冲突=已用过=重放
  const { error: nonceErr } = await svc.from('sso_nonces')
    .insert({ nonce, email, expires_at: new Date(Number(p.exp)).toISOString() } as never)
  if (nonceErr) return fail('replay')

  // 2. email 必须已是财务账号(决策:陌生 email 拒绝)
  const { data: prof } = await svc.from('profiles').select('id, email').eq('email', email).maybeSingle()
  if (!prof) return fail('no_account')

  // 3. 自建财务会话:admin 生成 magiclink 拿 hashed_token → verifyOtp 落 cookie
  const { data: link, error: linkErr } = await svc.auth.admin.generateLink({ type: 'magiclink', email })
  const hashedToken = (link as { properties?: { hashed_token?: string } } | null)?.properties?.hashed_token
  if (linkErr || !hashedToken) return fail('session_failed')

  // 会话 cookie 必须落到 redirect 响应上 —— 用绑定该响应的 SSR 客户端(同 middleware 写法)
  const response = NextResponse.redirect(new URL(redirectTo, request.url))
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) { cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options)) },
      },
    }
  )
  const { error: otpErr } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: hashedToken })
  if (otpErr) return fail('verify_failed')

  return response
}
