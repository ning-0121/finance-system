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
  Menu,
  X,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import { canViewApprovalQueue, getRoleLabel } from '@/lib/auth/permissions'
import { UserSwitcher } from '@/components/layout/UserSwitcher'
import { useState, useEffect } from 'react'
import { ClipboardCheck, ScrollText } from 'lucide-react'

const baseNavigation = [
  { name: '工作台', href: '/dashboard', icon: Home },
  { name: '订单成本核算', href: '/orders', icon: Package },
  { name: '文档智能中心', href: '/documents', icon: FileText },
  { name: '费用归集', href: '/costs', icon: ShoppingCart },
  { name: '应收应付管理', href: '/receivables', icon: CreditCard },
  { name: '汇总报表', href: '/reports', icon: ScrollText },
  { name: '付款审批与出纳', href: '/payments', icon: CheckSquare },
  { name: '客户画像', href: '/profiles/customers', icon: Users },
  { name: '供应商画像', href: '/profiles/suppliers', icon: FileText },
  { name: '财务驾驶舱', href: '/analytics', icon: BarChart3 },
  { name: '风险地图', href: '/risks', icon: BarChart3 },
  { name: '现金流预测', href: '/cashflow', icon: BarChart3 },
  { name: '老板驾驶舱', href: '/dashboard/boss', icon: BarChart3 },
]

export function Sidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { user } = useCurrentUser()

  // 根据角色动态生成导航
  const navigation = user && canViewApprovalQueue(user)
    ? [
        ...baseNavigation.slice(0, 2),
        { name: '审批队列', href: '/approvals', icon: ClipboardCheck },
        ...baseNavigation.slice(2),
      ]
    : baseNavigation

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const sidebarContent = (
    <>
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
          className="h-6 w-6 shrink-0 hidden md:flex"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <ChevronDown className={cn('h-3 w-3 transition-transform', collapsed ? '-rotate-90' : 'rotate-90')} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="关闭菜单"
        >
          <X className="h-4 w-4" />
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
              <item.icon className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
              {!collapsed && (
                <>
                  <span className="flex-1 truncate">{item.name}</span>
                  {'badge' in item && item.badge && (
                    <span className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                      {item.badge as number}
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
            <Bot className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
            <span>AI 助手</span>
            <span className="ml-auto text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full">在线</span>
          </Link>
        </div>
      )}

      {/* User Switcher (demo only) */}
      {!collapsed && <UserSwitcher />}

      {/* User */}
      <div className="border-t p-2">
        <button className={cn(
          'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm hover:bg-muted transition-colors',
          collapsed && 'justify-center px-0'
        )}>
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-xs bg-primary/10 text-primary">
              {user?.name?.charAt(0) || 'U'}
            </AvatarFallback>
          </Avatar>
          {!collapsed && user && (
            <div className="flex-1 text-left min-w-0">
              <p className="text-sm font-medium truncate">{user.name}</p>
              <p className="text-[10px] text-muted-foreground truncate">
                {getRoleLabel(user.role)}
              </p>
            </div>
          )}
        </button>
      </div>
    </>
  )

  return (
    <>
      {/* Mobile hamburger */}
      <Button
        variant="ghost"
        size="icon"
        className="fixed top-4 left-4 z-50 md:hidden"
        onClick={() => setMobileOpen(true)}
        aria-label="打开菜单"
      >
        <Menu className="h-5 w-5" />
      </Button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Mobile sidebar */}
      <div className={cn(
        'fixed inset-y-0 left-0 z-50 w-64 bg-white border-r transform transition-transform duration-300 md:hidden flex flex-col h-full',
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        {sidebarContent}
      </div>

      {/* Desktop sidebar */}
      <div className={cn(
        'hidden md:flex flex-col h-full bg-white border-r transition-all duration-300',
        collapsed ? 'w-16' : 'w-64'
      )}>
        {sidebarContent}
      </div>
    </>
  )
}
