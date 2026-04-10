'use client'

import { Bell, Search, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { demoAlerts } from '@/lib/demo-data'
import { useState } from 'react'

interface HeaderProps {
  title?: string
  subtitle?: string
}

export function Header({ title, subtitle }: HeaderProps) {
  const unreadAlerts = demoAlerts.filter(a => !a.is_read)
  const [showAlerts, setShowAlerts] = useState(false)

  return (
    <header className="flex items-center justify-between h-16 px-6 border-b bg-white shrink-0">
      <div>
        {title && <h2 className="text-lg font-semibold">{title}</h2>}
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-3">
        {/* Search */}
        <div className="relative hidden md:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索订单、客户..."
            className="pl-9 w-64 h-9"
          />
        </div>

        {/* AI Chat */}
        <Button variant="outline" size="icon" className="h-9 w-9 relative">
          <MessageSquare className="h-4 w-4" />
        </Button>

        {/* Notifications */}
        <div className="relative">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 relative"
            onClick={() => setShowAlerts(!showAlerts)}
          >
            <Bell className="h-4 w-4" />
            {unreadAlerts.length > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] text-white">
                {unreadAlerts.length}
              </span>
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
