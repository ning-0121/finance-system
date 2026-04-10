'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/lib/supabase/client'
import { Loader2 } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async () => {
    if (!email || !password) {
      setError('请输入邮箱和密码')
      return
    }
    setLoading(true)
    setError('')

    try {
      const supabase = createClient()
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

      if (authError) {
        setError(authError.message === 'Invalid login credentials' ? '邮箱或密码错误' : authError.message)
        setLoading(false)
        return
      }

      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('登录失败，请重试')
      setLoading(false)
    }
  }

  const handleDemoLogin = () => {
    setLoading(true)
    router.push('/dashboard')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-bold text-xl mb-4">
            F
          </div>
          <CardTitle className="text-2xl">外贸财务系统</CardTitle>
          <CardDescription>AI-Powered Foreign Trade Finance System</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm" role="alert">{error}</div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              placeholder="admin@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              disabled={loading}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              disabled={loading}
            />
          </div>
          <Button className="w-full" onClick={handleLogin} disabled={loading}>
            {loading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />登录中...</> : '登录'}
          </Button>
          <div className="relative">
            <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
            <div className="relative flex justify-center text-xs uppercase"><span className="bg-card px-2 text-muted-foreground">或</span></div>
          </div>
          <Button variant="outline" className="w-full" onClick={() => {
            const redirectUri = encodeURIComponent(`${window.location.origin}/api/auth/wecom`)
            const corpId = 'ww4b4c0f18eb6d77ad'
            const agentId = '1000003'
            window.location.href = `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${corpId}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_privateinfo&state=finance&agentid=${agentId}#wechat_redirect`
          }} disabled={loading}>
            企业微信登录
          </Button>
          <Button variant="ghost" className="w-full" onClick={handleDemoLogin} disabled={loading}>
            {loading ? '进入中...' : '演示模式体验'}
          </Button>
          <p className="text-xs text-center text-muted-foreground">演示模式使用模拟数据，无需注册</p>
        </CardContent>
      </Card>
    </div>
  )
}
