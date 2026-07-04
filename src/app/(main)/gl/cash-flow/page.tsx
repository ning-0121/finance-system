'use client'

// ============================================================
// 现金流量表（直接法简表，基于银行流水）
// 数据源：bank_transactions（#5 银行对账导入的真实流水）+ bank_accounts 余额。
// 按经营/投资/筹资三类汇总（默认归经营，投资/筹资按摘要关键词识别）。
// 选此口径而非 GL：现金的真实来源是银行流水，比灰度 GL 更准、当下即可用。
// ============================================================
import { useState, useEffect } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'

type Txn = { direction: 'in' | 'out'; amount: number; currency: string; summary: string | null; matched_type: string | null }
const r2 = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number) => `¥${r2(n).toLocaleString()}`

const INVEST_KW = ['投资', '购置', '设备', '固定资产', '理财', '购买资产']
const FINANCE_KW = ['借款', '贷款', '股东', '分红', '增资', '还款', '利息']
function classify(t: Txn): 'operating' | 'investing' | 'financing' {
  const s = t.summary || ''
  if (FINANCE_KW.some(k => s.includes(k))) return 'financing'
  if (INVEST_KW.some(k => s.includes(k))) return 'investing'
  return 'operating'  // 默认经营活动（服装外贸绝大多数现金流属经营）
}

export default function CashFlowPage() {
  const [period, setPeriod] = useState('')
  const [periods, setPeriods] = useState<{ code: string; start: string; end: string }[]>([])
  const [txns, setTxns] = useState<Txn[]>([])
  const [openingCash, setOpeningCash] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: p } = await supabase.from('accounting_periods').select('period_code, start_date, end_date').order('period_code', { ascending: false })
      if (p?.length) {
        const list = p.map(x => ({ code: x.period_code as string, start: x.start_date as string, end: x.end_date as string }))
        setPeriods(list)
        const current = new Date().toISOString().substring(0, 7)
        setPeriod(list.find(c => c.code === current)?.code || list[0].code)
      }
      setLoading(false)
    })()
  }, [])

  useEffect(() => {
    if (!period) return
    const p = periods.find(x => x.code === period)
    if (!p) return
    (async () => {
      setLoading(true)
      const supabase = createClient()
      // 本期流水（算流入流出）+ 期初前的历史流水（取各账户期初前最后一条 balance_after 作期初现金）
      // 期初只累计 CNY 账户余额：外币账户没有逐笔汇率，折算会失真，故不并入 ¥ 现金
      const [{ data: tx }, { data: prior }] = await Promise.all([
        fetchAll<Txn>((f, t2) => supabase.from('bank_transactions').select('direction, amount, currency, summary, matched_type, id')
          .gte('txn_date', p.start).lte('txn_date', p.end).neq('match_status', 'ignored').order('id', { ascending: true }).range(f, t2)),
        fetchAll<{ bank_account_id: string; balance_after: number | null; txn_date: string }>((f, t2) => supabase.from('bank_transactions')
          .select('bank_account_id, balance_after, txn_date').lt('txn_date', p.start).eq('currency', 'CNY').not('balance_after', 'is', null)
          .order('txn_date', { ascending: true }).order('id', { ascending: true }).range(f, t2)),
      ])
      setTxns((tx || []) as Txn[])
      // 期初现金 = 各 CNY 账户在期间开始前最后一条余额之和（按账户取最新 txn_date）
      const lastBal = new Map<string, number>()
      ;(prior || []).forEach(r => { lastBal.set(r.bank_account_id, Number(r.balance_after) || 0) })  // 已按 txn_date 升序，后者覆盖前者=最新
      setOpeningCash(r2([...lastBal.values()].reduce((s, v) => s + v, 0)))
      setLoading(false)
    })()
  }, [period, periods])

  // ¥ 现金流量表只统计 CNY 流水；外币流水单列（无逐笔汇率，不并入 ¥ 以免虚增/口径错乱）
  const cnyTxns = txns.filter(t => (t.currency || 'CNY') === 'CNY')
  const bucket = (cat: 'operating' | 'investing' | 'financing') => {
    const items = cnyTxns.filter(t => classify(t) === cat)
    const inflow = r2(items.filter(t => t.direction === 'in').reduce((s, t) => s + t.amount, 0))
    const outflow = r2(items.filter(t => t.direction === 'out').reduce((s, t) => s + t.amount, 0))
    return { inflow, outflow, net: r2(inflow - outflow) }
  }
  // 外币流水按币种汇总净额（原币，不折算）
  const foreignByCcy = txns.filter(t => (t.currency || 'CNY') !== 'CNY').reduce((m, t) => {
    const c = t.currency
    const cur = m.get(c) || { inflow: 0, outflow: 0 }
    if (t.direction === 'in') cur.inflow += t.amount; else cur.outflow += t.amount
    m.set(c, cur)
    return m
  }, new Map<string, { inflow: number; outflow: number }>())
  const op = bucket('operating'), inv = bucket('investing'), fin = bucket('financing')
  const netChange = r2(op.net + inv.net + fin.net)
  const closingCash = r2(openingCash + netChange)  // 期末 = 期初 + 本期净额（自洽，选历史期间也正确）
  const empty = txns.length === 0

  const Row = ({ label, value, bold }: { label: string; value: number; bold?: boolean }) => (
    <TableRow className={bold ? 'font-semibold bg-muted/30' : ''}>
      <TableCell className={bold ? '' : 'pl-8 text-sm text-muted-foreground'}>{label}</TableCell>
      <TableCell className={`text-right tabular-nums ${value < 0 ? 'text-red-600' : ''}`}>{fmt(value)}</TableCell>
    </TableRow>
  )

  return (
    <div className="flex flex-col h-full">
      <Header title="现金流量表" subtitle="直接法 · 基于银行流水（经营/投资/筹资）" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="flex items-center gap-3">
          <Select value={period} onValueChange={v => v && setPeriod(v)}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="期间" /></SelectTrigger>
            <SelectContent>{periods.map(p => <SelectItem key={p.code} value={p.code}>{p.code}</SelectItem>)}</SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">数据源：银行对账导入的流水（已忽略的非业务流水不计入）</span>
        </div>

        {!loading && foreignByCcy.size > 0 && (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="p-3 text-sm text-amber-800">
              <p className="font-medium">本期另有外币流水（原币列示，未折算并入 ¥ 现金流量表）：</p>
              <ul className="mt-1 space-y-0.5 text-xs">
                {[...foreignByCcy.entries()].map(([ccy, v]) => (
                  <li key={ccy} className="tabular-nums">
                    {ccy}：流入 {r2(v.inflow).toLocaleString()} · 流出 {r2(v.outflow).toLocaleString()} · 净额 {r2(v.inflow - v.outflow).toLocaleString()}
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-amber-700 mt-1">外币账户无逐笔汇率，折算会失真，故单列。如需并表请在结汇后以 ¥ 流水入账。</p>
            </CardContent>
          </Card>
        )}

        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : empty ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">
            <p>{period} 期间暂无银行流水</p>
            <p className="text-xs mt-1">现金流量表基于银行流水生成。请到「银行对账」导入该期间的对账单后，本表自动生成。</p>
          </CardContent></Card>
        ) : (
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">{period} 现金流量表（直接法）</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableBody>
                  <Row label="一、经营活动产生的现金流量" value={op.net} bold />
                  <Row label="　销售回款等现金流入" value={op.inflow} />
                  <Row label="　采购/费用/工资/税费等现金流出" value={-op.outflow} />
                  <Row label="二、投资活动产生的现金流量" value={inv.net} bold />
                  <Row label="　投资活动现金流入" value={inv.inflow} />
                  <Row label="　投资活动现金流出" value={-inv.outflow} />
                  <Row label="三、筹资活动产生的现金流量" value={fin.net} bold />
                  <Row label="　筹资活动现金流入" value={fin.inflow} />
                  <Row label="　筹资活动现金流出" value={-fin.outflow} />
                  <Row label="四、现金净增加额" value={netChange} bold />
                  <Row label="　加：期初现金余额" value={openingCash} />
                  <Row label="　期末现金余额" value={closingCash} bold />
                </TableBody>
              </Table>
              <p className="text-[11px] text-muted-foreground p-3">说明：期初现金 = 各银行账户在本期开始前最后一条对账单余额之和；期末现金 = 期初 + 本期净增加（选历史期间也准确）。投资/筹资按摘要关键词识别，其余归经营活动。</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
