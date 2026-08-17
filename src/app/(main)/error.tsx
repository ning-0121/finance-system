'use client'

/**
 * (main) 段错误边界(2026-08-17):页面级未捕获错误在应用壳内展示中文提示,
 * 不再整页跌到 Next 默认英文页。旧 chunk/RSC 失效特征 → 自动强刷一次(防循环)。
 */

import { useEffect } from 'react'

const CHUNK_ERROR_RE = /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch|Importing a module script failed|text\/html|NetworkError/i

export default function MainError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if (!CHUNK_ERROR_RE.test(`${error?.name || ''} ${error?.message || ''}`)) return
    const KEY = 'chunk-auto-reload-at'
    const last = Number(sessionStorage.getItem(KEY) || 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem(KEY, String(Date.now()))
    window.location.reload()
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-7 text-center shadow-sm">
        <div className="mb-2 text-4xl">⚠️</div>
        <h2 className="mb-2 text-lg font-bold text-gray-900">这个页面出错了</h2>
        <p className="mb-4 text-sm leading-relaxed text-gray-500">
          多数情况是系统刚更新、浏览器还留着旧版本导致,点击「重试」或刷新即可恢复。
          若反复出现,请把本页截图发给管理员。
        </p>
        <div className="mb-4 flex justify-center gap-2">
          <button onClick={reset} className="rounded-lg bg-gray-900 px-5 py-2 text-sm text-white hover:bg-gray-700">重试</button>
          <button onClick={() => window.location.reload()} className="rounded-lg border border-gray-300 bg-white px-5 py-2 text-sm text-gray-700 hover:bg-gray-50">刷新页面</button>
        </div>
        <div className="break-all rounded-lg bg-gray-50 px-3 py-2 text-left text-[11px] text-gray-400">
          {error?.digest ? `digest: ${error.digest} · ` : ''}{error?.message || '未知错误'}
        </div>
      </div>
    </div>
  )
}
