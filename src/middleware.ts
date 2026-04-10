import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // API 集成端点：由 API Key + 签名保护，不需要用户认证
  if (request.nextUrl.pathname.startsWith('/api/integration')) {
    return NextResponse.next()
  }

  // 已配置 Supabase 时启用用户认证
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (supabaseUrl && supabaseUrl !== 'your_supabase_url_here') {
    const { updateSession } = await import('@/lib/supabase/middleware')
    return await updateSession(request)
  }

  // 未配置 Supabase 时放行（演示模式）
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
