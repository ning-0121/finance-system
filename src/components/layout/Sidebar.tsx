'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
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
  TrendingUp,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useCurrentUser } from '@/lib/hooks/use-current-user'
import { canViewApprovalQueue, getRoleLabel } from '@/lib/auth/permissions'
import { UserSwitcher } from '@/components/layout/UserSwitcher'
import { useState, useEffect } from 'react'
import { ClipboardCheck, ScrollText, BookOpen, Calendar, Scale, Shield, Lock, Clock, FlaskConical, ShieldCheck, Search as SearchIcon, Landmark, LayoutGrid, Ship,
  Wallet, Banknote, Receipt, PiggyBank, LineChart, AlertTriangle, Gauge, Tag, Boxes, IdCard, Percent, FileSpreadsheet } from 'lucide-react'

// ── 导航信息架构(2026-08-02 重构)────────────────────────────────────
// 此前 34 项平铺 + 9 项控制中心 = 43 项一条直列,按功能上线先后堆叠,
// 找一个入口要从头扫到尾;且「总账模块」只用一行代码注释分隔(渲染出来什么都没有)。
// 现按【财务实际干活的顺序】分组:每天看的钉在顶部,其余按业务链路收进可折叠组。
// 收起态仍平铺全部图标(靠 title 提示),不牺牲老用户的肌肉记忆。

/** 钉在顶部——每天都要点的 */
const pinnedNavigation = [
  { name: '工作台', href: '/dashboard', icon: Home },
  { name: '多标签工作台', href: '/workspace', icon: LayoutGrid },
]

type NavItem = { name: string; href: string; icon: typeof Home }
type NavGroup = { key: string; name: string; icon: typeof Home; items: NavItem[] }

/**
 * 业务链路分组。同一件事的入口必须挨在一起——
 * 此前「付款审批与出纳 / 周排款 / 每周资金计划」散在列表三处,
 * 「应收账款 / 杂项应收」中间隔着别的模块,财务要来回找。
 */
const navGroups: NavGroup[] = [
  {
    key: 'order', name: '订单与成本', icon: Package,
    items: [
      { name: '订单成本核算', href: '/orders', icon: Package },
      { name: '费用归集', href: '/costs', icon: ShoppingCart },
      { name: '产品价格', href: '/product-price', icon: Tag },
      { name: '出运档案', href: '/shipments', icon: Ship },
      { name: '文档智能中心', href: '/documents', icon: FileSpreadsheet },
    ],
  },
  {
    key: 'buy', name: '采购与付款', icon: Wallet,
    items: [
      { name: '采购审批', href: '/purchase-approvals', icon: ShieldCheck },
      { name: '应付账款', href: '/payables', icon: Receipt },
      { name: '付款审批与出纳', href: '/payments', icon: CheckSquare },
      { name: '周排款（付款执行）', href: '/payment-batches', icon: Banknote },
      { name: '每周资金计划', href: '/funding-plan', icon: Calendar },
    ],
  },
  {
    key: 'sell', name: '收款与银行', icon: PiggyBank,
    items: [
      { name: '应收账款', href: '/receivables', icon: CreditCard },
      { name: '杂项应收', href: '/receivables/misc', icon: CreditCard },
      { name: '银行（日记账·对账）', href: '/bank', icon: Landmark },
      { name: '出口退税', href: '/tax-refund', icon: Percent },
    ],
  },
  {
    key: 'report', name: '报表与分析', icon: BarChart3,
    items: [
      { name: '汇总报表', href: '/reports', icon: ScrollText },
      { name: '经营报表（月/季/年）', href: '/reports/operating', icon: BarChart3 },
      { name: '老板驾驶舱', href: '/dashboard/boss', icon: Gauge },
      { name: '财务驾驶舱', href: '/analytics', icon: BarChart3 },
      { name: '利润控制中心', href: '/profit-control', icon: TrendingUp },
      { name: '现金流预测', href: '/cashflow', icon: LineChart },
      { name: '风险地图', href: '/risks', icon: AlertTriangle },
    ],
  },
  {
    key: 'gl', name: '总账', icon: BookOpen,
    items: [
      { name: '科目表', href: '/gl/accounts', icon: BookOpen },
      { name: '记账凭证', href: '/gl/journal', icon: FileText },
      { name: '试算平衡表', href: '/gl/trial-balance', icon: Scale },
      { name: '利润表', href: '/gl/profit-loss', icon: BarChart3 },
      { name: '资产负债表', href: '/gl/balance-sheet', icon: Scale },
      { name: '现金流量表', href: '/gl/cash-flow', icon: LineChart },
      { name: '会计期间', href: '/gl/periods', icon: Calendar },
    ],
  },
  {
    key: 'master', name: '档案与主数据', icon: Boxes,
    items: [
      { name: '客户财务档案', href: '/profiles/customers', icon: Users },
      { name: '供应商画像', href: '/profiles/suppliers', icon: Boxes },
      { name: '收款信息维护', href: '/profiles/bank-info', icon: IdCard },
      { name: '汇率维护', href: '/profiles/exchange-rates', icon: Percent },
      { name: '工资条发放', href: '/payroll', icon: Users },
    ],
  },
  {
    key: 'control', name: '控制中心', icon: Shield,
    items: [
      { name: '控制中心总览', href: '/control-center', icon: Shield },
      // 「可信度中心 /integrity」与「可信度 /trust」原为两个几乎同名、同图标的入口,
      // 财务分不清点哪个;改名点明各自职责(数据可信度体检 vs 对外可信度评分)。
      { name: '数据可信度体检', href: '/control-center/integrity', icon: ShieldCheck },
      { name: '可信度评分', href: '/control-center/trust', icon: Gauge },
      { name: 'GL 复核', href: '/control-center/gl-review', icon: ClipboardCheck },
      { name: '月结中心', href: '/control-center/closing', icon: Calendar },
      { name: '异常中心', href: '/control-center/audit', icon: SearchIcon },
      { name: '冻结控制', href: '/control-center/freeze', icon: Lock },
      { name: '时间线', href: '/control-center/timeline', icon: Clock },
      { name: '沙盘模拟', href: '/control-center/simulation', icon: FlaskConical },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  // 展开哪些分组:默认全收,但「当前页所在的组」自动展开(否则刷新后找不到自己在哪)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const toggleGroup = (k: string) => setOpenGroups(p => ({ ...p, [k]: !p[k] }))
  const { user } = useCurrentUser()
  // 待办数(集成/订单审批 + 采购审批)——财务人在任何页面都能看到有多少待处理(此前完全无通知)
  const [counts, setCounts] = useState({ approvals: 0, purchase: 0 })

  // 组的自动展开改为渲染期推导(openGroups[key] ?? 组内含当前页),
  // 不再用 effect 塞状态——避免「刷新后组是收的、要自己找」的老毛病。

  // 轮询待办数(60s):/approvals 角标 = pending_approvals + 预算单待审 + 订单作废终审;/purchase-approvals = 采购单待审
  //   此前只算 pending_approvals + 采购单 → 预算单待审、订单作废在角标里漏报(审计2026-07-27)
  useEffect(() => {
    if (!user) return
    let alive = true
    const load = async () => {
      try {
        const sb = createClient()
        const [a, p, b, v] = await Promise.all([
          sb.from('pending_approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
          sb.from('fin_purchase_orders').select('id', { count: 'exact', head: true }).eq('fin_status', 'pending_approval').is('deleted_at', null),
          sb.from('budget_orders').select('id', { count: 'exact', head: true }).eq('status', 'pending_review').is('deleted_at', null),
          sb.from('order_void_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        ])
        if (alive) setCounts({ approvals: (a.count || 0) + (b.count || 0) + (v.count || 0), purchase: p.count || 0 })
      } catch { /* 忽略,不阻断导航 */ }
    }
    load()
    const t = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(t) }
  }, [user, pathname])

  const badgeFor = (href: string) => href === '/purchase-approvals' ? counts.purchase : href === '/approvals' ? counts.approvals : 0

  // 根据角色动态生成导航
  // 审批队列按角色挂在置顶区(有待办徽标,属于「每天要点的」)
  const pinned = user && canViewApprovalQueue(user)
    ? [...pinnedNavigation, { name: '审批队列', href: '/approvals', icon: ClipboardCheck }]
    : pinnedNavigation
  // 收起态:平铺全部图标,保住老用户的位置记忆(靠 title 提示名称)
  const flatItems = [...pinned, ...navGroups.flatMap(g => g.items)]

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
        {collapsed ? (
          /* 收起态:平铺全部图标(保住位置记忆),名称走 title */
          flatItems.map(item => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Link key={item.href} href={item.href} title={item.name}
                className={cn('flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive ? 'bg-primary/5 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <div className="relative shrink-0">
                  <item.icon className="h-4.5 w-4.5" aria-hidden="true" />
                  {badgeFor(item.href) > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 h-2 w-2 rounded-full bg-amber-500" />
                  )}
                </div>
              </Link>
            )
          })
        ) : (
          <>
            {/* 置顶:每天要点的 */}
            {pinned.map(item => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
              return (
                <Link key={item.href} href={item.href}
                  className={cn('flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    isActive ? 'bg-primary/5 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                  <item.icon className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
                  <span className="flex-1 truncate">{item.name}</span>
                  {badgeFor(item.href) > 0 && (
                    <span className="ml-auto flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
                      {badgeFor(item.href)}
                    </span>
                  )}
                </Link>
              )
            })}

            {/* 业务分组 */}
            {navGroups.map(group => {
              const hasActive = group.items.some(i => pathname === i.href || pathname.startsWith(i.href + '/'))
              // 当前页所在组自动展开;用户手动切换后以手动状态为准
              const open = openGroups[group.key] ?? hasActive
              // 组内待办合计 → 收起时也能看见「这组里有事要办」
              const groupBadge = group.items.reduce((a, i) => a + badgeFor(i.href), 0)
              return (
                <div key={group.key} className="pt-1">
                  <button
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={open}
                    className={cn('flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold uppercase tracking-wide w-full transition-colors',
                      hasActive ? 'text-primary' : 'text-muted-foreground/70 hover:bg-muted hover:text-foreground')}>
                    <group.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1 truncate text-left normal-case tracking-normal text-sm font-medium">{group.name}</span>
                    {!open && groupBadge > 0 && (
                      <span className="flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
                        {groupBadge}
                      </span>
                    )}
                    <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', open ? '' : '-rotate-90')} />
                  </button>
                  {open && (
                    <div className="ml-3 pl-3 border-l space-y-0.5 mt-0.5">
                      {group.items.map(item => {
                        const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
                        return (
                          <Link key={item.href} href={item.href}
                            className={cn('flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
                              isActive ? 'bg-primary/5 text-primary font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                            <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="flex-1 truncate">{item.name}</span>
                            {badgeFor(item.href) > 0 && (
                              <span className="ml-auto flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
                                {badgeFor(item.href)}
                              </span>
                            )}
                          </Link>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
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
