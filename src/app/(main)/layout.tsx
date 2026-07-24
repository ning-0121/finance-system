'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { Sidebar } from '@/components/layout/Sidebar'
import { TabWorkspace } from '@/components/layout/TabWorkspace'
import { Toaster } from '@/components/ui/sonner'

function Shell({ children }: { children: React.ReactNode }) {
  // 嵌入模式(?embed=1):被多标签工作台的 iframe 加载 → 只渲染模块本体,去掉侧边栏(否则每个标签里又套一层侧栏)
  const embed = useSearchParams().get('embed') === '1'
  if (embed) {
    return <main className="h-screen overflow-y-auto bg-slate-50">{children}</main>
  }
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-hidden">
        <TabWorkspace>{children}</TabWorkspace>
      </main>
      <Toaster />
    </div>
  )
}

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<div className="h-screen bg-slate-50" />}>
      <Shell>{children}</Shell>
    </Suspense>
  )
}
