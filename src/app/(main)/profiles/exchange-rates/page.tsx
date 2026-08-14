'use client'

// 汇率维护(2026-08-12 第三轮审计 P0 落地)
// 背景:exchange_rates 表与财务可写策略 2026-06-11 就建好了,但【没有任何录入入口】,
// 于是全站外币兜底汇率停在 2026-06-15 的一条手工记录上,三轮审计连续点名。
// 本页 = 那个缺失的入口:录入走登录会话(RLS 限财务角色,created_by 记真实 auth.uid),
// 按 (币种, 日期) 唯一,历史全保留 —— 不改旧行,只追加新行。

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { bizToday } from '@/lib/biz-date'

const PAIRS = ['USD', 'EUR', 'GBP', 'JPY', 'HKD'] as const

interface RateRow {
  id: string
  base_currency: string
  rate: number
  rate_date: string
  source: string
  notes: string | null
  created_at: string
}

/** 距今天数(业务时区日期字符串直接比较,足够了) */
function daysAgo(d: string): number {
  return Math.floor((new Date(bizToday()).getTime() - new Date(d).getTime()) / 86400000)
}

export default function ExchangeRatesPage() {
  const [rows, setRows] = useState<RateRow[]>([])
  const [loading, setLoading] = useState(true)
  const [base, setBase] = useState<string>('USD')
  const [rate, setRate] = useState('')
  const [date, setDate] = useState(() => bizToday())
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const sb = createClient()
    const { data, error } = await sb.from('exchange_rates')
      .select('id, base_currency, rate, rate_date, source, notes, created_at')
      .eq('quote_currency', 'CNY')
      .order('rate_date', { ascending: false }).order('created_at', { ascending: false })
      .limit(60)
    if (error) { toast.error(`汇率读取失败：${error.message}`); return }
    setRows((data || []) as RateRow[])
  }, [])

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [load])

  // 每币种最新一条(用于顶部现行汇率卡)
  const latest = PAIRS.map(p => rows.find(r => r.base_currency === p)).filter(Boolean) as RateRow[]

  async function save() {
    const r = Number(rate)
    if (!(r > 0)) { toast.error('汇率必须大于 0'); return }
    if (r > 100) { toast.error(`汇率 ${r} 看起来不对（${base}→CNY 通常在个位数），请确认没把方向填反`) ; return }
    if (!date) { toast.error('请选择汇率日期'); return }
    setSaving(true)
    const sb = createClient()
    // upsert 按 (币种,日期) 唯一:同一天重复录入视为更正,覆盖当日值;历史日期各自保留
    const { error } = await sb.from('exchange_rates').upsert({
      base_currency: base, quote_currency: 'CNY', rate: r, rate_date: date,
      source: 'manual', notes: notes.trim() || null,
      fetched_at: new Date().toISOString(),
    }, { onConflict: 'base_currency,quote_currency,rate_date' })
    setSaving(false)
    if (error) { toast.error(`保存失败：${error.message}（需财务角色）`); return }
    toast.success(`${base}/CNY = ${r}（${date}）已保存`)
    setRate(''); setNotes('')
    await load()
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>

  return (
    <div className="flex flex-col h-full">
      <Header title="汇率维护" subtitle="市场参考汇率 · 全站外币兜底折算的来源 · 建议每周更新" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">

        {/* 现行汇率 + 新鲜度 —— 这是本页存在的原因:旧汇率会污染全站折算 */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {PAIRS.map(p => {
            const cur = latest.find(r => r.base_currency === p)
            const age = cur ? daysAgo(cur.rate_date) : null
            const stale = age == null ? 'none' : age > 30 ? 'red' : age > 7 ? 'amber' : 'ok'
            return (
              <Card key={p} className={stale === 'red' ? 'border-red-300' : stale === 'amber' ? 'border-amber-300' : ''}>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground mb-1">{p} / CNY</p>
                  <p className="text-2xl font-bold tabular-nums">{cur ? cur.rate : '—'}</p>
                  {cur ? (
                    <p className={`text-xs mt-1 ${stale === 'red' ? 'text-red-600 font-medium' : stale === 'amber' ? 'text-amber-600' : 'text-muted-foreground'}`}>
                      {cur.rate_date}{age != null && age > 0 ? `（${age} 天前${stale !== 'ok' ? '，已过期' : ''}）` : '（今天）'}
                    </p>
                  ) : (
                    <p className="text-xs mt-1 text-muted-foreground">从未录入</p>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* 录入 */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">录入汇率</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              方向为「1 外币 = ? 人民币」（如 USD/CNY = 7.12）。同一天重复录入视为更正、覆盖当日值；不同日期各自保留成历史。
              这里的汇率是<strong>市场参考价</strong>，用于订单缺结汇汇率时的兜底折算 —— 订单自身的结汇汇率仍以订单里填的为准。
            </p>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs">币种</Label>
                <select value={base} onChange={e => setBase(e.target.value)} aria-label="币种"
                  className="h-9 rounded-lg border bg-background px-3 text-sm">
                  {PAIRS.map(p => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">汇率（1 {base} = ? CNY）*</Label>
                <Input type="number" step="0.0001" min={0} className="w-32" value={rate}
                  onChange={e => setRate(e.target.value)} placeholder="如 7.12" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">汇率日期 *</Label>
                <Input type="date" className="w-40" value={date} onChange={e => setDate(e.target.value)} />
              </div>
              <div className="space-y-1 flex-1 min-w-[160px]">
                <Label className="text-xs">备注（来源，如「中行中间价」）</Label>
                <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="选填" />
              </div>
              <Button onClick={save} disabled={saving} className="gap-1.5">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}保存
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 历史 */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">历史记录<span className="text-sm font-normal text-muted-foreground ml-2">最近 60 条</span></CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>汇率日期</TableHead><TableHead>币种对</TableHead>
                <TableHead className="text-right">汇率</TableHead>
                <TableHead>来源</TableHead><TableHead>备注</TableHead><TableHead>录入时间</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {rows.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">尚无记录</TableCell></TableRow>
                )}
                {rows.map(r => (
                  <TableRow key={r.id}>
                    <TableCell className="text-sm">{r.rate_date}</TableCell>
                    <TableCell className="text-sm">{r.base_currency}/CNY</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{r.rate}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.source === 'manual' ? '手工' : r.source}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[220px] truncate" title={r.notes || ''}>{r.notes || '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{String(r.created_at).slice(0, 10)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground max-w-[74ch]">
          说明：全站有 125+ 张外币订单缺结汇汇率，它们的金额折算目前依赖本页的市场参考价。
          参考价过期会让应收、资金计划等页面的兜底折算失真 —— 这就是顶部新鲜度标红的原因。
          根治仍是进订单补结汇汇率；本页只保证「兜底价新鲜」。
        </p>
      </div>
    </div>
  )
}
