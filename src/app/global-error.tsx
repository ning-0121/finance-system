'use client'

/**
 * 全局错误兜底(2026-08-17)。此前项目无任何 error boundary,未捕获的客户端错误
 * 一律渲染 Next.js 内置英文页「This page couldn't load」(老板/财务多次撞上,无从排查)。
 * 高频部署后旧 chunk/RSC 失效是最常见诱因 → 命中特征时自动强刷一次(sessionStorage 防循环);
 * 其余错误显示中文说明 + 错误详情(截图即可定位)。
 */

import { useEffect } from 'react'

const CHUNK_ERROR_RE = /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch|Importing a module script failed|text\/html|NetworkError/i

function autoHealOnce(error: Error & { digest?: string }): boolean {
  if (typeof window === 'undefined') return false
  if (!CHUNK_ERROR_RE.test(`${error?.name || ''} ${error?.message || ''}`)) return false
  const KEY = 'chunk-auto-reload-at'
  const last = Number(sessionStorage.getItem(KEY) || 0)
  if (Date.now() - last < 60_000) return false // 一分钟内已自愈过,不再循环
  sessionStorage.setItem(KEY, String(Date.now()))
  window.location.reload()
  return true
}

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => { autoHealOnce(error) }, [error])
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif', background: '#f9fafb' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 460, width: '100%', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
            <h1 style={{ fontSize: 18, fontWeight: 700, color: '#111827', margin: '0 0 8px' }}>页面加载出错了</h1>
            <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 16px', lineHeight: 1.6 }}>
              多数情况是系统刚更新、浏览器还留着旧版本导致,刷新一次即可恢复。
              若反复出现,请把本页截图发给管理员。
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 16 }}>
              <button onClick={() => window.location.reload()} style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: '#111827', color: '#fff', fontSize: 14, cursor: 'pointer' }}>刷新页面</button>
              <button onClick={() => window.history.back()} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 14, cursor: 'pointer' }}>返回上一页</button>
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'left', background: '#f9fafb', borderRadius: 8, padding: '8px 12px', wordBreak: 'break-all' }}>
              {error?.digest ? `digest: ${error.digest} · ` : ''}{error?.message || '未知错误'}
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
