import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // 演示模式：暂时放行所有请求，待正式启用认证后切换
  // 如需启用认证，取消下方注释并删除 return NextResponse.next()
  return NextResponse.next()

  // const { updateSession } = await import('@/lib/supabase/middleware')
  // return await updateSession(request)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
