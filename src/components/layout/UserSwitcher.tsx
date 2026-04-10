'use client'

import { useCurrentUser } from '@/lib/hooks/use-current-user'
import { getRoleLabel } from '@/lib/auth/permissions'
import { cn } from '@/lib/utils'

export function UserSwitcher() {
  const { user, isDemo, switchDemoUser } = useCurrentUser()

  if (!isDemo || !user) return null

  return (
    <div className="px-3 pb-2">
      <p className="text-[10px] text-muted-foreground mb-1.5">演示账号切换</p>
      <div className="flex gap-1">
        <button
          onClick={() => switchDemoUser('fiona')}
          className={cn(
            'flex-1 text-[11px] py-1.5 rounded-md transition-colors',
            user.email === 'fiona@qimoclothing.com'
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-muted'
          )}
        >
          方圆<br /><span className="text-[9px] opacity-70">{getRoleLabel('finance_staff')}</span>
        </button>
        <button
          onClick={() => switchDemoUser('su')}
          className={cn(
            'flex-1 text-[11px] py-1.5 rounded-md transition-colors',
            user.email === 'su@qimoclothing.com'
              ? 'bg-primary/10 text-primary font-medium'
              : 'text-muted-foreground hover:bg-muted'
          )}
        >
          Su<br /><span className="text-[9px] opacity-70">{getRoleLabel('finance_manager')}</span>
        </button>
      </div>
    </div>
  )
}
