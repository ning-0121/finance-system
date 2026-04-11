// API路由认证守卫 — 所有API必须通过认证
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export interface AuthResult {
  authenticated: boolean
  userId?: string
  role?: string
  error?: NextResponse
}

/**
 * 验证API请求的认证状态
 * 返回 userId 和 role，或 401 错误响应
 */
export async function requireAuth(): Promise<AuthResult> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      // 检查是否demo模式（仅开发环境）
      const isDev = process.env.NODE_ENV === 'development'
      if (isDev) {
        // 开发环境下允许使用profiles中的第一个用户
        const { data: profiles } = await supabase.from('profiles').select('id, role').limit(1)
        if (profiles?.length) {
          return { authenticated: true, userId: profiles[0].id, role: profiles[0].role as string || 'finance_staff' }
        }
      }
      return {
        authenticated: false,
        error: NextResponse.json({ error: '未登录，请先登录' }, { status: 401 }),
      }
    }

    // 获取用户角色
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()

    return {
      authenticated: true,
      userId: user.id,
      role: (profile?.role as string) || 'finance_staff',
    }
  } catch {
    return {
      authenticated: false,
      error: NextResponse.json({ error: '认证失败' }, { status: 401 }),
    }
  }
}

/**
 * 检查用户是否具有指定角色
 */
export function requireRole(auth: AuthResult, roles: string[]): NextResponse | null {
  if (!auth.authenticated || !auth.role) {
    return NextResponse.json({ error: '未授权' }, { status: 403 })
  }
  if (!roles.includes(auth.role)) {
    return NextResponse.json({ error: `需要角色: ${roles.join('/')}` }, { status: 403 })
  }
  return null
}

/**
 * 检查是否自审批（创建者不能审批自己的记录）
 */
export function checkSelfApproval(operatorId: string, creatorId: string): NextResponse | null {
  if (operatorId === creatorId) {
    return NextResponse.json({ error: '不能审批自己创建的记录' }, { status: 403 })
  }
  return null
}
