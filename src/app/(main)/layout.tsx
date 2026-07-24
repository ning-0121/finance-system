'use client'

import { useState, useEffect } from 'react'
import { Sidebar } from '@/components/layout/Sidebar'
import { Toaster } from '@/components/ui/sonner'

export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // 嵌入模式(?embed=1):被多标签工作台的 iframe 加载 → 隐藏侧边栏(否则每个标签里又套一层侧栏)。
  // 纯 client 探测(挂载后读 window.location),失败/未命中一律走正常布局 —— 绝不影响其它页面渲染。
  const [embed, setEmbed] = useState(false)
  useEffect(() => {
    try { setEmbed(new URLSearchParams(window.location.search).get('embed') === '1') } catch { /* 忽略 → 正常布局 */ }
  }, [])
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {!embed && <Sidebar />}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
      <Toaster />
    </div>
  )
}
