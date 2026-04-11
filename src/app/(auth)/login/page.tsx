'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { createClient } from '@/lib/supabase/client'
import { Loader2 } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [mode, setMode] = useState<'login' | 'register'>('login')

  const handleLogin = async () => {
    if (!email || !password) { setError('请输入邮箱和密码'); return }
    setLoading(true); setError(''); setSuccess('')

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

  const handleRegister = async () => {
    if (!email || !password) { setError('请输入邮箱和密码'); return }
    if (password.length < 6) { setError('密码至少6位'); return }
    setLoading(true); setError(''); setSuccess('')

    try {
      const supabase = createClient()
      const { error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { name: email.split('@')[0] },
        },
      })

      if (authError) {
        if (authError.message.includes('already registered')) {
          setError('该邮箱已注册，请直接登录')
        } else {
          setError(authError.message)
        }
        setLoading(false)
        return
      }

      setSuccess('注册成功！请查收邮箱确认链接，或直接登录')
      setMode('login')
      setLoading(false)
    } catch {
      setError('注册失败，请重试')
      setLoading(false)
    }
  }

  const handleDemoLogin = () => {
    setLoading(true)
    document.cookie = 'finance_demo_mode=true; path=/; max-age=604800'
    router.push('/dashboard')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground font-bold text-xl mb-4">
            绮
          </div>
          <CardTitle className="text-2xl">绮陌服饰财务系统</CardTitle>
          <CardDescription>AI-Powered Foreign Trade Finance System</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-50 text-red-700 text-sm" role="alert">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-green-50 text-green-700 text-sm" role="alert">{success}</div>}

          <Tabs value={mode} onValueChange={v => { setMode(v as 'login' | 'register'); setError(''); setSuccess('') }}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">登录</TabsTrigger>
              <TabsTrigger value="register">注册</TabsTrigger>
            </TabsList>

            <TabsContent value="login" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="login-email">邮箱</Label>
                <Input id="login-email" type="email" placeholder="su@qimoclothing.com" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleLogin()} disabled={loading} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="login-password">密码</Label>
                <Input id="login-password" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleLogin()} disabled={loading} />
              </div>
              <Button className="w-full" onClick={handleLogin} disabled={loading}>
                {loading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />登录中...</> : '登录'}
              </Button>
            </TabsContent>

            <TabsContent value="register" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="reg-email">邮箱</Label>
                <Input id="reg-email" type="email" placeholder="your@qimoclothing.com" value={email} onChange={e => setEmail(e.target.value)} disabled={loading} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reg-password">密码（至少6位）</Label>
                <Input id="reg-password" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleRegister()} disabled={loading} />
              </div>
              <Button className="w-full" onClick={handleRegister} disabled={loading}>
                {loading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />注册中...</> : '注册账号'}
              </Button>
              <p className="text-xs text-muted-foreground text-center">注册后系统自动创建财务档案</p>
            </TabsContent>
          </Tabs>

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
