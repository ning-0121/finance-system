'use client'

// ============================================================
// 资产负债表（GL 科目余额表驱动，会计准则口径）
// 资产 = 负债 + 所有者权益（含本期净利润）。勾稽自动校验，不平醒目提示。
// 数据源：gl_balances + accounts.account_type。GL 为灰度过账——未过账的业务
// 尚不计入，页面如实标注（待 GL 复核中心把凭证过账后自动补全）。
// ============================================================
import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type Bal = {
  account_code: string; account_name: string; account_type: string
  closing_debit: number; closing_credit: number
  period_debit: number; period_credit: number
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
      const { data } = await supabase.from('gl_balances')
        .select('account_code, closing_debit, closing_credit, period_debit, period_credit, accounts(account_name, account_type)')
        .eq('period_code', period).order('account_code')
      setRows((data || []).map(b => ({
        account_code: b.account_code as string,
        account_name: (b.accounts as unknown as Record<string, string>)?.account_name || '',
        account_type: (b.accounts as unknown as Record<string, string>)?.account_type || '',
        closing_debit: Number(b.closing_debit) || 0,
        closing_credit: Number(b.closing_credit) || 0,
        period_debit: Number(b.period_debit) || 0,
        period_credit: Number(b.period_credit) || 0,
      })))
      setLoading(false)
    })()
  }, [period])

  // 资产：借方余额；负债/权益：贷方余额
  const assets = rows.filter(r => r.account_type === 'asset').map(r => ({ ...r, amount: r2(r.closing_debit - r.closing_credit) })).filter(r => Math.abs(r.amount) > 0.005)
  const liabilities = rows.filter(r => r.account_type === 'liability').map(r => ({ ...r, amount: r2(r.closing_credit - r.closing_debit) })).filter(r => Math.abs(r.amount) > 0.005)
  const equity = rows.filter(r => r.account_type === 'equity').map(r => ({ ...r, amount: r2(r.closing_credit - r.closing_debit) })).filter(r => Math.abs(r.amount) > 0.005)
  // 本期净利润（未结转进权益前，用 P&L 发生额补到右侧做勾稽）
  const periodRevenue = rows.filter(r => r.account_type === 'revenue').reduce((s, r) => s + (r.period_credit - r.period_debit), 0)
  const periodExpense = rows.filter(r => r.account_type === 'expense').reduce((s, r) => s + (r.period_debit - r.period_credit), 0)
  const netProfit = r2(periodRevenue - periodExpense)

  const totalAssets = r2(assets.reduce((s, r) => s + r.amount, 0))
  const totalLiab = r2(liabilities.reduce((s, r) => s + r.amount, 0))
  const totalEquityBase = r2(equity.reduce((s, r) => s + r.amount, 0))
  const totalEquity = r2(totalEquityBase + netProfit)
  const rightTotal = r2(totalLiab + totalEquity)
  const diff = r2(totalAssets - rightTotal)
  const balanced = Math.abs(diff) < 1
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
            ? <span className="inline-flex items-center text-sm text-green-600"><CheckCircle2 className="h-4 w-4 mr-1" />勾稽平衡（资产 = 负债 + 权益）</span>
            : <span className="inline-flex items-center text-sm text-red-600"><AlertTriangle className="h-4 w-4 mr-1" />不平衡：差额 {fmt(diff)}（GL 灰度未过账完整时属正常）</span>)}
        </div>

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : empty ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">
            <p>{period} 期间 GL 暂无余额数据</p>
            <p className="text-xs mt-1">资产负债表由总账科目余额生成。请在「控制中心 → GL 复核」把业务凭证过账后，本表自动补全。</p>
          </CardContent></Card>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Section title="资产" items={assets} total={totalAssets} />
              <div className="space-y-4">
                <Section title="负债" items={liabilities} total={totalLiab} />
                <Section title="所有者权益" items={[...equity, ...(Math.abs(netProfit) > 0.005 ? [{ account_code: '—', account_name: '本期净利润（未结转）', amount: netProfit }] : [])]} total={totalEquity} />
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
