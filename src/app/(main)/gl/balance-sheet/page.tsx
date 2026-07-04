'use client'

// ============================================================
// 资产负债表（GL 科目余额表驱动，会计准则口径）
// 资产 = 负债 + 所有者权益（含累计净利润）。勾稽自动校验，不平醒目提示。
// 数据源：gl_balances.period_debit/period_credit（本期发生额，由过账触发器维护）。
// 期末余额由「≤所选期间的发生额累计」重构 —— gl_balances.closing_* 触发器不维护，
// 恒为 0，故不能直接用（原实现读 closing_* 导致本表恒空/不平）。因每张已过账凭证
// 借贷相等且未做利润结转，累计口径下「资产 = 负债 + 权益 + 累计净利润」精确成立。
// ============================================================
import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

// 每科目：cum* = ≤所选期间的累计发生额（重构期末余额）；cur* = 所选期间发生额（本期净利润用）
type Bal = {
  account_code: string; account_name: string; account_type: string
  cumDebit: number; cumCredit: number
  curDebit: number; curCredit: number
}
const r2 = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number) => `¥${r2(n).toLocaleString()}`

export default function BalanceSheetPage() {
  const [period, setPeriod] = useState('')
  const [periods, setPeriods] = useState<string[]>([])
  const [rows, setRows] = useState<Bal[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: p } = await supabase.from('accounting_periods').select('period_code').order('period_code', { ascending: false })
      if (p?.length) {
        const codes = p.map(x => x.period_code as string)
        setPeriods(codes)
        const current = new Date().toISOString().substring(0, 7)
        setPeriod(codes.find(c => c === current) || codes[0])
      }
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!period) return
    (async () => {
      setLoading(true)
      const supabase = createClient()
      // 取 ≤ 所选期间的全部发生额行（period_code 为 'YYYY-MM'，字典序 <= 即时间 <=）
      const { data } = await supabase.from('gl_balances')
        .select('account_code, period_code, period_debit, period_credit, accounts(account_name, account_type)')
        .lte('period_code', period)
        .order('account_code')
      // 按科目累计：cum=全部≤period，cur=仅=period
      const agg = new Map<string, Bal>()
      for (const b of data || []) {
        const code = b.account_code as string
        const acc = b.accounts as unknown as Record<string, string> | null
        const pd = Number(b.period_debit) || 0
        const pc = Number(b.period_credit) || 0
        const isCur = (b.period_code as string) === period
        const cur = agg.get(code) || {
          account_code: code,
          account_name: acc?.account_name || '',
          account_type: acc?.account_type || '',
          cumDebit: 0, cumCredit: 0, curDebit: 0, curCredit: 0,
        }
        cur.cumDebit += pd; cur.cumCredit += pc
        if (isCur) { cur.curDebit += pd; cur.curCredit += pc }
        agg.set(code, cur)
      }
      setRows([...agg.values()])
      setLoading(false)
    })()
  }, [period])

  // 资产：借方累计余额；负债/权益：贷方累计余额
  const assets = rows.filter(r => r.account_type === 'asset').map(r => ({ ...r, amount: r2(r.cumDebit - r.cumCredit) })).filter(r => Math.abs(r.amount) > 0.005)
  const liabilities = rows.filter(r => r.account_type === 'liability').map(r => ({ ...r, amount: r2(r.cumCredit - r.cumDebit) })).filter(r => Math.abs(r.amount) > 0.005)
  const equity = rows.filter(r => r.account_type === 'equity').map(r => ({ ...r, amount: r2(r.cumCredit - r.cumDebit) })).filter(r => Math.abs(r.amount) > 0.005)
  // 累计净利润（未结转）拆两行：期初留存(<period) + 本期净利润(=period)，合计=累计
  const cumNetProfit = r2(
    rows.filter(r => r.account_type === 'revenue').reduce((s, r) => s + (r.cumCredit - r.cumDebit), 0) -
    rows.filter(r => r.account_type === 'expense').reduce((s, r) => s + (r.cumDebit - r.cumCredit), 0)
  )
  const curNetProfit = r2(
    rows.filter(r => r.account_type === 'revenue').reduce((s, r) => s + (r.curCredit - r.curDebit), 0) -
    rows.filter(r => r.account_type === 'expense').reduce((s, r) => s + (r.curDebit - r.curCredit), 0)
  )
  const priorRetained = r2(cumNetProfit - curNetProfit)

  const totalAssets = r2(assets.reduce((s, r) => s + r.amount, 0))
  const totalLiab = r2(liabilities.reduce((s, r) => s + r.amount, 0))
  const totalEquityBase = r2(equity.reduce((s, r) => s + r.amount, 0))
  const totalEquity = r2(totalEquityBase + cumNetProfit)
  const rightTotal = r2(totalLiab + totalEquity)
  const diff = r2(totalAssets - rightTotal)
  const balanced = Math.abs(diff) < 0.01  // 会计报表按分平衡（原 ±1 偏松，会掩盖小额过账错误）
  const empty = rows.length === 0

  const Section = ({ title, items, total }: { title: string; items: { account_code: string; account_name: string; amount: number }[]; total: number }) => (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {items.map(it => (
              <TableRow key={it.account_code}>
                <TableCell className="text-sm text-muted-foreground">{it.account_code}</TableCell>
                <TableCell className="text-sm">{it.account_name}</TableCell>
                <TableCell className="text-right tabular-nums text-sm">{fmt(it.amount)}</TableCell>
              </TableRow>
            ))}
            {items.length === 0 && <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground text-sm py-4">无数据</TableCell></TableRow>}
            <TableRow className="border-t-2 font-semibold bg-muted/30">
              <TableCell colSpan={2}>{title}合计</TableCell>
              <TableCell className="text-right tabular-nums">{fmt(total)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )

  return (
    <div className="flex flex-col h-full">
      <Header title="资产负债表" subtitle="GL 科目余额表驱动 · 资产 = 负债 + 所有者权益" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="flex items-center gap-3 flex-wrap">
          <Select value={period} onValueChange={v => v && setPeriod(v)}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="期间" /></SelectTrigger>
            <SelectContent>{periods.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
          </Select>
          {!empty && (balanced
            ? <span className="inline-flex items-center text-sm text-green-600"><CheckCircle2 className="h-4 w-4 mr-1" />勾稽平衡（资产 = 负债 + 权益 + 累计净利润）</span>
            : <span className="inline-flex items-center text-sm text-red-600"><AlertTriangle className="h-4 w-4 mr-1" />不平衡：差额 {fmt(diff)}（存在单边过账/未过账凭证，请到 GL 复核核对）</span>)}
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : empty ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">
            <p>截至 {period} 暂无已过账的 GL 凭证</p>
            <p className="text-xs mt-1">资产负债表由已过账凭证的发生额累计生成。请在「控制中心 → GL 复核」把业务凭证过账后，本表自动补全。</p>
          </CardContent></Card>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Section title="资产" items={assets} total={totalAssets} />
              <div className="space-y-4">
                <Section title="负债" items={liabilities} total={totalLiab} />
                <Section title="所有者权益" items={[
                  ...equity,
                  ...(Math.abs(priorRetained) > 0.005 ? [{ account_code: '—', account_name: '期初未分配利润（累计未结转）', amount: priorRetained }] : []),
                  ...(Math.abs(curNetProfit) > 0.005 ? [{ account_code: '—', account_name: '本期净利润（未结转）', amount: curNetProfit }] : []),
                ]} total={totalEquity} />
              </div>
            </div>
            <Card className={balanced ? 'border-green-200' : 'border-red-200'}>
              <CardContent className="p-4 grid grid-cols-3 gap-4 text-center">
                <div><p className="text-xs text-muted-foreground">资产总计</p><p className="text-xl font-bold">{fmt(totalAssets)}</p></div>
                <div><p className="text-xs text-muted-foreground">负债 + 权益</p><p className="text-xl font-bold">{fmt(rightTotal)}</p></div>
                <div><p className="text-xs text-muted-foreground">差额</p><p className={`text-xl font-bold ${balanced ? 'text-green-600' : 'text-red-600'}`}>{fmt(diff)}</p></div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
