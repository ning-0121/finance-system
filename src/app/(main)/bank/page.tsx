'use client'

// ============================================================
// 银行对账（Phase 2 #5）— 给现金上锚
// 导入银行对账单流水 → 与系统回款/付款逐笔对账 → 刷新账户真实余额。
// 收(in)匹配回款，付(out)匹配付款；自动建议金额相等且日期最近的候选。
// ============================================================
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import * as XLSX from 'xlsx'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Upload, Link2, X, RefreshCw, ArrowDownCircle, ArrowUpCircle } from 'lucide-react'
import { toast } from 'sonner'
import { bizToday } from '@/lib/biz-date'
import {
  getBankAccounts, getBankTransactions, importBankTransactions, refreshAccountBalance,
  getMatchCandidates, suggestMatch, matchBankTxn, unmatchBankTxn, ignoreBankTxn,
  type BankTxn, type MatchCandidate,
} from '@/lib/supabase/bank'

type Account = { id: string; account_name: string; bank_name: string; account_number: string; currency: string; current_balance: number }
const parseNum = (v: unknown) => { const n = Number(String(v ?? '').replace(/[,¥$\s]/g, '')); return isNaN(n) ? 0 : n }

export default function BankReconcilePage() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountId, setAccountId] = useState('')
  const [txns, setTxns] = useState<BankTxn[]>([])
  const [candIn, setCandIn] = useState<MatchCandidate[]>([])
  const [candOut, setCandOut] = useState<MatchCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'unmatched' | 'matched' | 'ignored'>('unmatched')

  // 导入
  const [importOpen, setImportOpen] = useState(false)
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [colMap, setColMap] = useState<Record<string, string>>({ date: '', income: '', expense: '', balance: '', counterparty: '', summary: '', reference: '' })
  const [importing, setImporting] = useState(false)

  // 匹配弹窗
  const fileRef = useRef<HTMLInputElement>(null)
  const [matchDialog, setMatchDialog] = useState<BankTxn | null>(null)
  const [ignoreDialog, setIgnoreDialog] = useState<BankTxn | null>(null)
  const [ignoreNote, setIgnoreNote] = useState('')

  const account = accounts.find(a => a.id === accountId)

  const loadTxns = useCallback(async (accId: string) => {
    setLoading(true)
    try {
      const [t, ci, co] = await Promise.all([getBankTransactions(accId), getMatchCandidates('in'), getMatchCandidates('out')])
      setTxns(t); setCandIn(ci); setCandOut(co)
    } catch (e) { toast.error(`加载失败：${e instanceof Error ? e.message : '未知'}（若提示表不存在，请先执行迁移 20260612_bank_transactions.sql）`) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    getBankAccounts().then(a => {
      setAccounts(a as Account[])
      if (a.length > 0) { setAccountId(a[0].id); loadTxns(a[0].id) }
      else setLoading(false)
    }).catch(() => setLoading(false))
  }, [loadTxns])

  const onFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true, cellNF: true })
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '', blankrows: false, raw: false }) as Record<string, unknown>[]
      if (rows.length === 0) { toast.error('未解析到数据行'); return }
      setRawRows(rows)
      const hs = Object.keys(rows[0])
      setHeaders(hs)
      // 智能猜列
      const guess = (kw: string[]) => hs.find(h => kw.some(k => h.includes(k))) || ''
      setColMap({
        date: guess(['日期', '交易时间', '记账日']),
        income: guess(['收入', '贷方', '存入', '收款']),
        expense: guess(['支出', '借方', '支取', '付款']),
        balance: guess(['余额']),
        counterparty: guess(['对方户名', '对方账户名', '对手', '户名']),
        summary: guess(['摘要', '用途', '附言', '备注']),
        reference: guess(['流水号', '交易流水', '凭证号', '业务流水']),
      })
      setImportOpen(true)
    } catch (e) { toast.error(`解析失败：${e instanceof Error ? e.message : '未知'}`) }
  }

  const buildImportRows = () => {
    const out: { txn_date: string; direction: 'in' | 'out'; amount: number; balance_after: number | null; counterparty: string; summary: string; reference: string }[] = []
    for (const r of rawRows) {
      const dateRaw = colMap.date ? r[colMap.date] : ''
      const d = dateRaw instanceof Date ? dateRaw : new Date(String(dateRaw))
      if (isNaN(d.getTime())) continue
      const txn_date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d)
      const income = colMap.income ? parseNum(r[colMap.income]) : 0
      const expense = colMap.expense ? parseNum(r[colMap.expense]) : 0
      let direction: 'in' | 'out'; let amount: number
      if (income !== 0 || expense !== 0) {
        if (Math.abs(income) >= Math.abs(expense)) { direction = income >= 0 ? 'in' : 'out'; amount = Math.abs(income) }
        else { direction = expense >= 0 ? 'out' : 'in'; amount = Math.abs(expense) }
      } else continue // 收支都为0的行跳过
      out.push({
        txn_date, direction, amount,
        balance_after: colMap.balance ? parseNum(r[colMap.balance]) : null,
        counterparty: colMap.counterparty ? String(r[colMap.counterparty] || '') : '',
        summary: colMap.summary ? String(r[colMap.summary] || '') : '',
        reference: colMap.reference ? String(r[colMap.reference] || '') : '',
      })
    }
    return out
  }

  const doImport = async () => {
    if (!accountId) { toast.error('请先选择银行账户'); return }
    if (!colMap.date || (!colMap.income && !colMap.expense)) { toast.error('请至少映射「日期」和「收入/支出」列'); return }
    setImporting(true)
    try {
      const rows = buildImportRows()
      if (rows.length === 0) { toast.error('没有可导入的有效流水行'); setImporting(false); return }
      const batch = `import-${bizToday()}-${Date.now()}`
      const { inserted, skipped, error } = await importBankTransactions(accountId, rows, batch)
      if (error) throw new Error(error)
      const bal = await refreshAccountBalance(accountId)
      toast.success(`导入完成：新增 ${inserted} 笔${skipped > 0 ? `，跳过重复 ${skipped} 笔` : ''}${bal != null ? `，账户余额更新为 ¥${bal.toLocaleString()}` : ''}`)
      setImportOpen(false); setRawRows([])
      await loadTxns(accountId)
      // 刷新账户余额展示
      setAccounts(prev => prev.map(a => a.id === accountId && bal != null ? { ...a, current_balance: bal } : a))
    } catch (e) { toast.error(`导入失败：${e instanceof Error ? e.message : '未知'}`) }
    finally { setImporting(false) }
  }

  const confirmMatch = async (txn: BankTxn, cand: MatchCandidate) => {
    const { error } = await matchBankTxn(txn.id, txn.direction === 'in' ? 'receivable_payment' : 'supplier_payment', cand.id)
    if (error) { toast.error(`匹配失败：${error}`); return }
    toast.success('已对账')
    setTxns(prev => prev.map(t => t.id === txn.id ? { ...t, match_status: 'matched', matched_type: txn.direction === 'in' ? 'receivable_payment' : 'supplier_payment', matched_id: cand.id } : t))
    setMatchDialog(null)
  }
  const doUnmatch = async (txn: BankTxn) => {
    const { error } = await unmatchBankTxn(txn.id)
    if (error) { toast.error(`取消失败：${error}`); return }
    setTxns(prev => prev.map(t => t.id === txn.id ? { ...t, match_status: 'unmatched', matched_id: null, matched_type: null } : t))
  }
  const doIgnore = async () => {
    if (!ignoreDialog || !ignoreNote.trim()) { toast.error('请填写忽略原因'); return }
    const { error } = await ignoreBankTxn(ignoreDialog.id, ignoreNote.trim())
    if (error) { toast.error(`操作失败：${error}`); return }
    setTxns(prev => prev.map(t => t.id === ignoreDialog.id ? { ...t, match_status: 'ignored', match_note: ignoreNote.trim() } : t))
    setIgnoreDialog(null); setIgnoreNote('')
  }

  const filtered = txns.filter(t => t.match_status === tab)
  const stats = useMemo(() => {
    const unm = txns.filter(t => t.match_status === 'unmatched')
    return {
      unmatched: unm.length,
      unmatchedInCny: unm.filter(t => t.direction === 'in').reduce((s, t) => s + t.amount, 0),
      unmatchedOutCny: unm.filter(t => t.direction === 'out').reduce((s, t) => s + t.amount, 0),
      matched: txns.filter(t => t.match_status === 'matched').length,
    }
  }, [txns])

  return (
    <div className="flex flex-col h-full">
      <Header title="银行对账" subtitle="导入对账单 · 与回款/付款逐笔对账 · 账户余额上锚" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        {accounts.length === 0 && !loading ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">
            <p>暂无启用的银行账户</p>
            <p className="text-xs mt-1">请先到 GL → 科目表 / 银行账户 维护银行账户，再回来导入对账单</p>
          </CardContent></Card>
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <Select value={accountId} onValueChange={v => { if (v) { setAccountId(v); loadTxns(v) } }}>
                <SelectTrigger className="w-[260px]"><SelectValue placeholder="选择银行账户" /></SelectTrigger>
                <SelectContent>
                  {accounts.map(a => <SelectItem key={a.id} value={a.id}>{a.account_name}（{a.account_number.slice(-4)}）</SelectItem>)}
                </SelectContent>
              </Select>
              {account && <Badge variant="outline" className="text-sm">账户余额 ¥{Number(account.current_balance || 0).toLocaleString()}</Badge>}
              <div className="ml-auto flex gap-2">
                <Button variant="outline" size="sm" onClick={() => accountId && loadTxns(accountId)}><RefreshCw className="h-4 w-4 mr-1" />刷新</Button>
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { onFile(e.target.files?.[0]); if (fileRef.current) fileRef.current.value = '' }} />
                <Button size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4 mr-1" />导入对账单</Button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">未对账笔数</p><p className="text-2xl font-bold text-amber-600">{stats.unmatched}</p></CardContent></Card>
              <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">未对账收入</p><p className="text-xl font-bold text-green-600">¥{stats.unmatchedInCny.toLocaleString()}</p></CardContent></Card>
              <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">未对账支出</p><p className="text-xl font-bold text-red-600">¥{stats.unmatchedOutCny.toLocaleString()}</p></CardContent></Card>
              <Card><CardContent className="p-3"><p className="text-xs text-muted-foreground">已对账笔数</p><p className="text-2xl font-bold text-green-600">{stats.matched}</p></CardContent></Card>
            </div>

            <Tabs value={tab} onValueChange={v => setTab(v as typeof tab)}>
              <TabsList>
                <TabsTrigger value="unmatched">未对账 ({txns.filter(t => t.match_status === 'unmatched').length})</TabsTrigger>
                <TabsTrigger value="matched">已对账 ({stats.matched})</TabsTrigger>
                <TabsTrigger value="ignored">已忽略 ({txns.filter(t => t.match_status === 'ignored').length})</TabsTrigger>
              </TabsList>
            </Tabs>

            {loading ? (
              <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <Card>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>日期</TableHead><TableHead>收/付</TableHead><TableHead className="text-right">金额</TableHead>
                    <TableHead>对方/摘要</TableHead><TableHead>建议匹配</TableHead><TableHead className="text-right">操作</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {filtered.map(t => {
                      const cands = t.direction === 'in' ? candIn : candOut
                      const sug = t.match_status === 'unmatched' ? suggestMatch(t, cands) : null
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="text-xs whitespace-nowrap">{t.txn_date}</TableCell>
                          <TableCell>{t.direction === 'in'
                            ? <span className="inline-flex items-center text-green-600 text-sm"><ArrowDownCircle className="h-4 w-4 mr-1" />收</span>
                            : <span className="inline-flex items-center text-red-600 text-sm"><ArrowUpCircle className="h-4 w-4 mr-1" />付</span>}</TableCell>
                          <TableCell className={`text-right tabular-nums font-medium ${t.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>¥{t.amount.toLocaleString()}</TableCell>
                          <TableCell className="text-xs max-w-[220px]"><span className="block truncate">{t.counterparty || '—'}</span><span className="block truncate text-muted-foreground">{t.summary || ''}</span></TableCell>
                          <TableCell className="text-xs">
                            {t.match_status === 'matched' ? <span className="text-green-700">已匹配{cands.find(c => c.id === t.matched_id)?.label ? `：${cands.find(c => c.id === t.matched_id)?.label}` : ''}</span>
                              : t.match_status === 'ignored' ? <span className="text-muted-foreground">{t.match_note}</span>
                              : sug ? <span className="text-primary">{sug.label}</span>
                              : <span className="text-muted-foreground">无匹配候选</span>}
                          </TableCell>
                          <TableCell className="text-right space-x-1">
                            {t.match_status === 'unmatched' && <>
                              {sug && <Button size="sm" variant="outline" className="h-7" onClick={() => confirmMatch(t, sug)}><Link2 className="h-3 w-3 mr-1" />确认匹配</Button>}
                              <Button size="sm" variant="ghost" className="h-7" onClick={() => setMatchDialog(t)}>手动</Button>
                              <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => { setIgnoreDialog(t); setIgnoreNote('') }}><X className="h-3 w-3" /></Button>
                            </>}
                            {t.match_status === 'matched' && <Button size="sm" variant="ghost" className="h-7" onClick={() => doUnmatch(t)}>取消匹配</Button>}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {filtered.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">{tab === 'unmatched' ? '全部已对账 🎉' : '无记录'}</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </Card>
            )}
          </>
        )}
      </div>

      {/* 导入列映射 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>导入对账单 — 列映射（已解析 {rawRows.length} 行）</DialogTitle></DialogHeader>
          <div className="space-y-2 py-2 max-h-[60vh] overflow-y-auto">
            <p className="text-xs text-muted-foreground">系统已尝试自动识别列；请确认。至少需要「日期」+「收入」或「支出」。</p>
            {([['date', '日期 *'], ['income', '收入/贷方金额'], ['expense', '支出/借方金额'], ['balance', '余额'], ['counterparty', '对方户名'], ['summary', '摘要'], ['reference', '流水号']] as const).map(([key, label]) => (
              <div key={key} className="grid grid-cols-3 items-center gap-2">
                <Label className="text-xs">{label}</Label>
                <Select value={colMap[key] || '__none__'} onValueChange={v => setColMap(m => ({ ...m, [key]: (v && v !== '__none__') ? v : '' }))}>
                  <SelectTrigger className="col-span-2 h-8"><SelectValue placeholder="（不映射）" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">（不映射）</SelectItem>
                    {headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>取消</Button>
            <Button onClick={doImport} disabled={importing}>{importing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}导入</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 手动匹配 */}
      {matchDialog && (
        <Dialog open onOpenChange={() => setMatchDialog(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>手动匹配 — {matchDialog.direction === 'in' ? '收' : '付'} ¥{matchDialog.amount.toLocaleString()}（{matchDialog.txn_date}）</DialogTitle></DialogHeader>
            <div className="max-h-[55vh] overflow-y-auto space-y-1 py-2">
              {(matchDialog.direction === 'in' ? candIn : candOut)
                .slice()
                .sort((a, b) => Math.abs(a.amount - matchDialog.amount) - Math.abs(b.amount - matchDialog.amount))
                .slice(0, 50)
                .map(c => (
                  <button key={c.id} className="w-full text-left px-3 py-2 rounded hover:bg-muted text-sm flex justify-between" onClick={() => confirmMatch(matchDialog, c)}>
                    <span>{c.label}</span><span className="text-xs text-muted-foreground">{c.date?.slice(0, 10)}</span>
                  </button>
                ))}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* 忽略 */}
      {ignoreDialog && (
        <Dialog open onOpenChange={() => setIgnoreDialog(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>忽略此流水</DialogTitle></DialogHeader>
            <Textarea rows={3} placeholder="忽略原因（必填）：如银行手续费、内部调拨等非业务流水" value={ignoreNote} onChange={e => setIgnoreNote(e.target.value)} />
            <DialogFooter>
              <Button variant="outline" onClick={() => setIgnoreDialog(null)}>取消</Button>
              <Button onClick={doIgnore}>确认忽略</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
