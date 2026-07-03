'use client'

// ============================================================
// 供应商归并 — 扫描 5 张表的在用名字，财务勾选多个旧名 → 选标准名 →
// 预览各表受影响行数 → 单事务 RPC 执行(历史改名+档案合并+别名登记+审计)。
// 疑似同家的名字(归一化前缀相同)自动排在一起并高亮提示。
// ============================================================

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Merge, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { normalizeSupplierName } from '@/lib/utils'

interface NameUsage {
  name: string
  cost: number      // cost_items 行数
  pay: number       // supplier_payments
  payable: number   // payable_records
  invoice: number   // actual_invoices
  po: number        // fin_purchase_orders
  total: number
  groupKey: string  // 相似度分组键（归一化前3字符）
}

export function SupplierMergeDialog({ open, onOpenChange, onMerged }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onMerged: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [names, setNames] = useState<NameUsage[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [canonical, setCanonical] = useState('')
  const [q, setQ] = useState('')
  const [merging, setMerging] = useState(false)

  const scan = useCallback(async () => {
    setLoading(true)
    const sb = createClient()
    // 逐表取 supplier 名（fetchAll 防 1000 行截断），客户端聚合计数
    const [cost, pay, payable, invoice, po] = await Promise.all([
      fetchAll<Record<string, unknown>>((f, t) => sb.from('cost_items').select('supplier').is('deleted_at', null).not('supplier', 'is', null).order('id', { ascending: true }).range(f, t)),
      fetchAll<Record<string, unknown>>((f, t) => sb.from('supplier_payments').select('supplier_name').is('deleted_at', null).order('id', { ascending: true }).range(f, t)),
      fetchAll<Record<string, unknown>>((f, t) => sb.from('payable_records').select('supplier_name').is('deleted_at', null).order('id', { ascending: true }).range(f, t)),
      fetchAll<Record<string, unknown>>((f, t) => sb.from('actual_invoices').select('supplier_name').is('deleted_at', null).not('supplier_name', 'is', null).order('id', { ascending: true }).range(f, t)),
      fetchAll<Record<string, unknown>>((f, t) => sb.from('fin_purchase_orders').select('supplier_name').is('deleted_at', null).not('supplier_name', 'is', null).order('id', { ascending: true }).range(f, t)),
    ])
    const map = new Map<string, NameUsage>()
    const bump = (raw: unknown, key: keyof Pick<NameUsage, 'cost' | 'pay' | 'payable' | 'invoice' | 'po'>) => {
      const name = String(raw || '').trim()
      if (!name) return
      const e = map.get(name) || { name, cost: 0, pay: 0, payable: 0, invoice: 0, po: 0, total: 0, groupKey: normalizeSupplierName(name).slice(0, 3) }
      e[key] += 1; e.total += 1
      map.set(name, e)
    }
    ;(cost.data || []).forEach(r => bump(r.supplier, 'cost'))
    ;(pay.data || []).forEach(r => bump(r.supplier_name, 'pay'))
    ;(payable.data || []).forEach(r => bump(r.supplier_name, 'payable'))
    ;(invoice.data || []).forEach(r => bump(r.supplier_name, 'invoice'))
    ;(po.data || []).forEach(r => bump(r.supplier_name, 'po'))
    // 供应商档案里有但业务表还没用过的名字也列出（可作标准名）
    const { data: masters } = await sb.from('suppliers').select('name').is('deleted_at', null)
    ;(masters || []).forEach(m => {
      const name = String(m.name || '').trim()
      if (name && !map.has(name)) map.set(name, { name, cost: 0, pay: 0, payable: 0, invoice: 0, po: 0, total: 0, groupKey: normalizeSupplierName(name).slice(0, 3) })
    })
    // 排序：分组键聚在一起（疑似同家相邻），组内按用量降序
    const arr = [...map.values()].sort((a, b) => a.groupKey === b.groupKey ? b.total - a.total : a.groupKey.localeCompare(b.groupKey))
    setNames(arr)
    setLoading(false)
  }, [])

  useEffect(() => { if (open) { scan(); setSelected(new Set()); setCanonical(''); setQ('') } }, [open, scan])

  // 疑似同家分组：同 groupKey 且组内 ≥2 个名字
  const dupGroups = useMemo(() => {
    const g = new Map<string, number>()
    names.forEach(n => g.set(n.groupKey, (g.get(n.groupKey) || 0) + 1))
    return new Set([...g.entries()].filter(([, c]) => c >= 2).map(([k]) => k))
  }, [names])

  const shown = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return qq ? names.filter(n => n.name.toLowerCase().includes(qq)) : names
  }, [names, q])

  const toggle = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) { next.delete(name); if (canonical === name) setCanonical('') }
      else next.add(name)
      return next
    })
  }

  const selectedRows = names.filter(n => selected.has(n.name))
  const aliasRows = selectedRows.filter(n => n.name !== canonical)
  const preview = aliasRows.reduce((s, n) => ({
    cost: s.cost + n.cost, pay: s.pay + n.pay, payable: s.payable + n.payable,
    invoice: s.invoice + n.invoice, po: s.po + n.po,
  }), { cost: 0, pay: 0, payable: 0, invoice: 0, po: 0 })

  const doMerge = async () => {
    if (selected.size < 2) { toast.error('请至少勾选 2 个名字（含标准名）'); return }
    if (!canonical || !selected.has(canonical)) { toast.error('请在勾选的名字中指定一个作为标准名'); return }
    const aliases = aliasRows.map(n => n.name)
    if (!confirm(`确认把 ${aliases.length} 个旧名归并为「${canonical}」？\n\n${aliases.join('、')}\n\n历史数据(约 ${preview.cost + preview.pay + preview.payable + preview.invoice + preview.po} 行)将统一改名，旧名以后自动归到标准名。此操作写入审计，不可自动撤销。`)) return
    setMerging(true)
    try {
      const sb = createClient()
      const { data: userData } = await sb.auth.getUser()
      const { data, error } = await sb.rpc('merge_supplier_names', {
        p_aliases: aliases, p_canonical: canonical, p_actor: userData?.user?.id || null,
      })
      if (error) { toast.error(`归并失败：${error.message}`); return }
      const r = data as Record<string, number>
      toast.success(`已归并为「${canonical}」：费用${r.cost_items}行 · 付款${r.supplier_payments}行 · 应付${r.payable_records}行 · 发票${r.actual_invoices}行 · 采购单${r.fin_purchase_orders}行`)
      onOpenChange(false)
      onMerged()
    } finally { setMerging(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>归并供应商（多个名字 → 一个标准名）</DialogTitle></DialogHeader>
        <div className="space-y-3 py-1">
          <p className="text-xs text-muted-foreground">
            勾选属于同一家的多个名字 → 点其中一个的「设为标准名」→ 执行。历史数据(费用/付款/应付/发票/采购单)统一改名，
            旧名登记为别名，以后任何入口出现旧名自动归到标准名。<b className="text-amber-600">黄色行 = 疑似同一家（名字前缀相近）</b>。
          </p>
          <div className="relative max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input placeholder="搜名字..." className="pl-8 h-8 text-sm" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {loading ? (
            <div className="flex justify-center py-14"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="border rounded-lg divide-y max-h-[380px] overflow-y-auto">
              {shown.map(n => {
                const checked = selected.has(n.name)
                const isCanon = canonical === n.name
                const suspicious = dupGroups.has(n.groupKey)
                return (
                  <div key={n.name} className={`flex items-center gap-2 px-3 py-1.5 text-sm ${suspicious ? 'bg-amber-50/60' : ''} ${checked ? 'ring-1 ring-inset ring-primary/30' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(n.name)} className="rounded" />
                    <span className="flex-1 truncate font-medium">{n.name}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                      费用{n.cost} · 付款{n.pay} · 应付{n.payable} · 发票{n.invoice} · 采购{n.po}
                    </span>
                    {checked && (
                      isCanon
                        ? <Badge className="bg-green-100 text-green-700 border-0 text-[10px] shrink-0">标准名</Badge>
                        : <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] shrink-0" onClick={() => setCanonical(n.name)}>设为标准名</Button>
                    )}
                  </div>
                )
              })}
              {shown.length === 0 && <p className="text-center text-sm text-muted-foreground py-10">无匹配名字</p>}
            </div>
          )}
          {selected.size >= 2 && canonical && (
            <div className="text-xs bg-muted/40 rounded-md p-2.5">
              预览：<b>{aliasRows.map(n => n.name).join('、')}</b> → <b className="text-green-700">{canonical}</b>
              ；将改名 费用{preview.cost} · 付款{preview.pay} · 应付{preview.payable} · 发票{preview.invoice} · 采购单{preview.po} 行
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={doMerge} disabled={merging || selected.size < 2 || !canonical}>
            {merging ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Merge className="h-4 w-4 mr-1" />}执行归并
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
