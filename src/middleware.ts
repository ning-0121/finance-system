import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // 演示模式：如果没有配置Supabase，直接放行
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL === 'your_supabase_url_here') {
    return NextResponse.next()
  }

  // 生产模式：使用Supabase认证
  const { updateSession } = await import('@/lib/supabase/middleware')
  return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
