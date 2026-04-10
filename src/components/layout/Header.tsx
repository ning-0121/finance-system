'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Search, MessageSquare, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { demoAlerts } from '@/lib/demo-data'

interface HeaderProps {
  title?: string
  subtitle?: string
}

interface SearchResult {
  type: string
  title: string
  subtitle: string
  href: string
}

export function Header({ title, subtitle }: HeaderProps) {
  const router = useRouter()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const [showAlerts, setShowAlerts] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const unreadAlerts = demoAlerts.filter(a => !a.is_read)

  // 防抖搜索
  useEffect(() => {
    if (searchQuery.length < 2) { setSearchResults([]); setShowResults(false); return }

    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}`)
        const data = await res.json()
        setSearchResults(data.results || [])
        setShowResults(true)
      } catch {
        setSearchResults([])
      }
      setSearching(false)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchQuery])

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowResults(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const typeColors: Record<string, string> = {
    '订单': 'bg-blue-100 text-blue-700',
    '客户': 'bg-green-100 text-green-700',
    '发票': 'bg-purple-100 text-purple-700',
    '费用': 'bg-amber-100 text-amber-700',
    '风险': 'bg-red-100 text-red-700',
  }

  return (
    <header className="flex items-center justify-between h-16 px-6 border-b bg-white shrink-0">
      <div>
        {title && <h2 className="text-lg font-semibold">{title}</h2>}
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-3">
        {/* 全局搜索 */}
        <div className="relative hidden md:block" ref={searchRef}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
          <Input
            placeholder="搜索订单、客户、发票..."
            className="pl-9 w-72 h-9"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onFocus={() => { if (searchResults.length) setShowResults(true) }}
          />
          {showResults && searchResults.length > 0 && (
            <div className="absolute top-full mt-1 w-96 bg-white rounded-lg border shadow-lg z-50 py-1 max-h-[400px] overflow-y-auto">
              {searchResults.map((r, i) => (
                <button
                  key={i}
                  className="flex items-start gap-3 w-full px-4 py-2.5 hover:bg-muted text-left transition-colors"
                  onClick={() => { router.push(r.href); setShowResults(false); setSearchQuery('') }}
                >
                  <Badge className={`${typeColors[r.type] || 'bg-gray-100 text-gray-700'} border-0 text-[10px] shrink-0 mt-0.5`}>
                    {r.type}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{r.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{r.subtitle}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
          {showResults && searchResults.length === 0 && searchQuery.length >= 2 && !searching && (
            <div className="absolute top-full mt-1 w-72 bg-white rounded-lg border shadow-lg z-50 p-4 text-center text-sm text-muted-foreground">
              没有找到匹配结果
            </div>
          )}
        </div>

        <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => router.push('/ai')}>
          <MessageSquare className="h-4 w-4" />
        </Button>

        {/* 通知 */}
        <div className="relative">
          <Button variant="outline" size="icon" className="h-9 w-9 relative" onClick={() => setShowAlerts(!showAlerts)}>
            <Bell className="h-4 w-4" />
            {unreadAlerts.length > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] text-white">{unreadAlerts.length}</span>
            )}
          </Button>
          {showAlerts && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowAlerts(false)} />
              <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-lg border shadow-lg z-50 py-1">
                {demoAlerts.slice(0, 5).map((alert) => (
                  <div key={alert.id} className="flex flex-col items-start gap-1 py-3 px-4 hover:bg-muted cursor-pointer">
                    <div className="flex items-center gap-2">
                      <Badge variant={alert.severity === 'critical' ? 'destructive' : alert.severity === 'warning' ? 'secondary' : 'outline'} className="text-[10px]">
                        {alert.severity === 'critical' ? '严重' : alert.severity === 'warning' ? '警告' : '提示'}
                      </Badge>
                      <span className="text-sm font-medium">{alert.title}</span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">{alert.message}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
