'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import {
  Package,
  ShoppingCart,
  CreditCard,
  CheckSquare,
  Users,
  FileText,
  BarChart3,
  Home,
  ChevronDown,
  Bot,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { demoUser } from '@/lib/demo-data'
import { useState } from 'react'

const navigation = [
  { name: '工作台', href: '/dashboard', icon: Home },
  { name: '订单成本核算', href: '/orders', icon: Package, badge: 3 },
  { name: '采购与工厂管理', href: '/procurement', icon: ShoppingCart },
  { name: '应收应付管理', href: '/receivables', icon: CreditCard },
  { name: '付款审批与出纳', href: '/payments', icon: CheckSquare },
  { name: '员工薪酬管理', href: '/payroll', icon: Users },
  { name: '报关资料管理', href: '/customs', icon: FileText },
  { name: '财务驾驶舱', href: '/analytics', icon: BarChart3 },
]

export function Sidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const user = demoUser

  return (
    <div className={cn(
      'flex flex-col h-full bg-white border-r transition-all duration-300',
      collapsed ? 'w-16' : 'w-64'
    )}>
      {/* Logo */}
      <div className="flex items-center gap-2 px-4 h-16 border-b shrink-0">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">
          F
        </div>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold truncate">外贸财务系统</h1>
            <p className="text-[10px] text-muted-foreground">AI-Powered Finance</p>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => setCollapsed(!collapsed)}
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', collapsed ? '-rotate-90' : 'rotate-90')} />
        </Button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-2 px-2 space-y-0.5 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/5 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
              title={collapsed ? item.name : undefined}
            >
              <item.icon className="h-4.5 w-4.5 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 truncate">{item.name}</span>
                  {item.badge && (
                    <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                      {item.badge}
                    </span>
                  )}
                </>
              )}
            </Link>
          )
        })}
      </nav>

      {/* AI Assistant */}
      {!collapsed && (
        <div className="px-2 pb-2">
          <Link
            href="/ai"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <Bot className="h-4.5 w-4.5 shrink-0" />
            <span>AI 助手</span>
            <span className="ml-auto text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">在线</span>
          </Link>
        </div>
      )}

      {/* User */}
      <div className="border-t p-2">
        <button className={cn(
          'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm hover:bg-muted transition-colors',
          collapsed && 'justify-center px-0'
        )}>
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-xs bg-primary/10 text-primary">
              {user.name.charAt(0)}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="flex-1 text-left min-w-0">
              <p className="text-sm font-medium truncate">{user.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">
                {user.role === 'admin' ? '系统管理员' : user.role}
              </p>
            </div>
          )}
        </button>
      </div>
    </div>
  )
}
