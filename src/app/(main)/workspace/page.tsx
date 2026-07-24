'use client'

/**
 * 多标签工作台(2026-07-24 安全重做)
 * 独立页面(不改全局布局,坏了也波及不到别的页面/登录)。同屏并排开多个模块、切回不重查:
 * 每个标签 = 一个 iframe(?embed=1 隐藏侧栏),藏起的 iframe 仍挂载 → 数据/滚动/查询状态全留。
 * ⧉ 并排 = 左右两个 iframe 同屏。
 */

import { useState } from 'react'
import { X, Plus, Columns2, Square, RefreshCw, LayoutGrid } from 'lucide-react'

// 可开成标签的模块(名 + 路径),与侧栏一致。iframe src = href + '?embed=1'。
const MODULES: { name: string; href: string }[] = [
  { name: '工作台', href: '/dashboard' },
  { name: '订单成本核算', href: '/orders' },
  { name: '审批队列', href: '/approvals' },
  { name: '费用归集', href: '/costs' },
  { name: '采购审批', href: '/purchase-approvals' },
  { name: '应收账款', href: '/receivables' },
  { name: '应付账款', href: '/payables' },
  { name: '汇总报表', href: '/reports' },
  { name: '付款审批与出纳', href: '/payments' },
  { name: '周排款', href: '/payment-batches' },
  { name: '银行(日记账·对账)', href: '/bank' },
  { name: '收款信息维护', href: '/profiles/bank-info' },
  { name: '利润控制中心', href: '/profit-control' },
  { name: '财务驾驶舱', href: '/analytics' },
]

type Tab = { id: string; title: string; href: string }

export default function WorkspacePage() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [leftId, setLeftId] = useState<string | null>(null)    // 主窗格
  const [rightId, setRightId] = useState<string | null>(null)  // 并排的第二窗格(可空)
  const [picker, setPicker] = useState(false)
  const [nonce, setNonce] = useState<Record<string, number>>({})
  let seq = tabs.length

  const open = (m: { name: string; href: string }) => {
    setPicker(false)
    const exist = tabs.find(t => t.href === m.href)
    if (exist) { setLeftId(exist.id); return }
    const id = `${m.href}#${seq++}`
    setTabs(prev => [...prev, { id, title: m.name, href: m.href }])
    setLeftId(id)
  }
  const close = (id: string) => {
    setTabs(prev => prev.filter(t => t.id !== id))
    if (leftId === id) setLeftId(rightId && rightId !== id ? rightId : (tabs.find(t => t.id !== id)?.id ?? null))
    if (rightId === id) setRightId(null)
  }
  const toggleSplit = (id: string) => {
    if (rightId === id) { setRightId(null); return }
    if (leftId === id) return
    setRightId(id)
  }
  const reload = (id: string) => setNonce(n => ({ ...n, [id]: (n[id] || 0) + 1 }))
  const split = rightId != null && tabs.some(t => t.id === rightId)

  return (
    <div className="flex flex-col h-full">
      {/* 标签栏 */}
      <div className="flex items-center gap-1 px-2 h-11 shrink-0 border-b bg-white overflow-x-auto">
        <div className="relative shrink-0">
          <button onClick={() => setPicker(p => !p)}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-sm text-slate-600 hover:bg-slate-100 border">
            <Plus className="h-3.5 w-3.5" />打开模块
          </button>
          {picker && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setPicker(false)} />
              <div className="absolute left-0 top-8 z-20 w-52 max-h-80 overflow-y-auto rounded-lg border bg-white shadow-lg py-1">
                {MODULES.map(m => (
                  <button key={m.href} onClick={() => open(m)}
                    className="block w-full text-left px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">{m.name}</button>
                ))}
              </div>
            </>
          )}
        </div>
        {tabs.map(t => {
          const active = t.id === leftId || t.id === rightId
          return (
            <div key={t.id}
              className={`group inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-md text-sm shrink-0 cursor-pointer border
                ${active ? 'bg-blue-50 border-blue-300 text-blue-800' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              onClick={() => setLeftId(t.id)}>
              <span className="max-w-[130px] truncate">{t.title}</span>
              {t.id === rightId && <span className="text-[10px] text-blue-500">右</span>}
              <button title="并排显示" onClick={e => { e.stopPropagation(); toggleSplit(t.id) }}
                className="p-0.5 rounded hover:bg-blue-100 text-slate-400 hover:text-blue-600">
                {t.id === rightId ? <Square className="h-3 w-3" /> : <Columns2 className="h-3 w-3" />}
              </button>
              <button title="刷新" onClick={e => { e.stopPropagation(); reload(t.id) }}
                className="p-0.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 opacity-0 group-hover:opacity-100">
                <RefreshCw className="h-3 w-3" />
              </button>
              <button title="关闭" onClick={e => { e.stopPropagation(); close(t.id) }}
                className="p-0.5 rounded hover:bg-red-100 text-slate-400 hover:text-red-600">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
        {tabs.length > 0 && <span className="ml-auto shrink-0 text-[11px] text-slate-400 pr-2">切标签不重查 · 点 ⧉ 并排</span>}
      </div>

      {/* 工作区:iframe 保活(藏起的仍挂载 → 数据不丢) */}
      <div className="flex-1 min-h-0">
        {tabs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
            <LayoutGrid className="h-10 w-10" />
            <p className="text-sm">点左上「＋ 打开模块」开始 —— 可同屏并排开多个,来回切不重查。</p>
          </div>
        ) : (
          <div className="flex h-full w-full">
            {tabs.map(t => {
              const visible = t.id === leftId || (split && t.id === rightId)
              const widthCls = split && (t.id === leftId || t.id === rightId) ? 'w-1/2' : 'w-full'
              return (
                <iframe
                  key={t.id}
                  src={`${t.href}?embed=1${nonce[t.id] ? `&r=${nonce[t.id]}` : ''}`}
                  title={t.title}
                  className={`h-full border-0 border-r last:border-r-0 ${visible ? widthCls : 'hidden'}`}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
