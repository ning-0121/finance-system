// ============================================================
// GET /api/auth/wecom — 企业微信OAuth回调
// 流程: 企业微信扫码 → code → 获取用户身份 → 创建/更新系统账号 → 登录
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { getUserByCode, getUserInfo } from '@/lib/wecom/client'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const redirectTo = request.nextUrl.searchParams.get('state') || '/dashboard'

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=no_code', request.url))
  }

  try {
    // 1. 用code换取企业微信用户身份
    const authResult = await getUserByCode(code)
    if (authResult.errcode !== 0 || !authResult.UserId) {
      console.error('[WeChat Auth] Failed:', authResult)
      return NextResponse.redirect(new URL('/login?error=wecom_auth_failed', request.url))
    }

    const wecomUserId = authResult.UserId

    // 2. 获取用户详细信息
    const userInfo = await getUserInfo(wecomUserId)
    const name = userInfo.name || wecomUserId
    const email = userInfo.email || `${wecomUserId}@qimoclothing.com`
    const mobile = userInfo.mobile || ''
    const department = userInfo.department?.[0] || null
    const position = userInfo.position || ''
    const avatar = userInfo.avatar || ''

    // 3. 在Supabase中查找或创建用户
    const supabase = await createClient()

    // 检查是否已有该企业微信ID的profile
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id, email')
      .eq('email', email)
      .single()

    if (existingProfile) {
      // 更新企业微信信息
      await supabase
        .from('profiles')
        .update({
          name,
          avatar_url: avatar || null,
          department: position || department?.toString() || null,
        })
        .eq('id', existingProfile.id)
    } else {
      // 首次企业微信登录 — 创建 profile（role 默认 finance_staff，管理员可后续调整）
      const { error: insertErr } = await supabase
        .from('profiles')
        .insert({
          email,
          name,
          role: 'finance_staff',
          avatar_url: avatar || null,
          department: position || department?.toString() || null,
        })
      if (insertErr) {
        console.error('[WeChat Auth] Profile insert failed:', insertErr.message)
        return NextResponse.redirect(new URL('/login?error=profile_create_failed', request.url))
      }
    }

    // 4. 重定向到系统
    const response = NextResponse.redirect(new URL(redirectTo, request.url))

    // 设置cookie标记企业微信登录状态
    response.cookies.set('wecom_user_id', wecomUserId, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 86400 * 7, // 7天
    })
    response.cookies.set('wecom_user_name', encodeURIComponent(name), {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      maxAge: 86400 * 7,
    })

    return response
  } catch (error) {
    console.error('[WeChat Auth] Error:', error)
    return NextResponse.redirect(new URL('/login?error=wecom_error', request.url))
  }
}
