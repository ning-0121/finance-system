'use client'

// ============================================================
// 对账 Tab（合并页 · 由父级共享账户驱动）
// 导入银行对账单流水 → 与系统回款/付款/关联往来逐笔对账 → 刷新账户真实余额。
// 收(in)候选=客户回款+关联往来；付(out)候选=供应商付款+关联往来。
// 账户选择在父级；本组件只认 accountId。
// ============================================================
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import * as XLSX from 'xlsx'
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
  getBankTransactions, importBankTransactions, refreshAccountBalance,
  getMatchCandidates, suggestMatch, matchBankTxn, unmatchBankTxn, ignoreBankTxn,
  candidateMatchedType, createManualAndMatch, guessNature, checkStatementDays,
  type BankTxn, type MatchCandidate,
} from '@/lib/supabase/bank'
import { getJournal } from '@/lib/supabase/bank-journal'

// 直接记账（无对应系统单据时）可选类别 —— 现金收支式口径，按用途分组顺序排列
const BOOK_CATEGORIES = [
  '银行手续费', '税费', '工资', '快递费', '办公费', '业务招待费', '样品费', '利息', '其他费用',  // 费用
  '老板垫付', '员工借支', '其他应收款', '其他应付款', '股东往来', '备用金',                        // 往来
  '内部转账', '取现', '其他收入', '其他支出',                                                   // 转账/其他
] as const
const SOURCE_LABEL: Record<MatchCandidate['source'], string> = { receivable: '客户回款', supplier: '供应商付款', manual: '关联往来' }
const parseNum = (v: unknown) => { const n = Number(String(v ?? '').replace(/[,¥$\s]/g, '')); return isNaN(n) ? 0 : n }

export function ReconcileTab({ accountId, currentBalance, onBalanceChange }: {
  accountId: string
  currentBalance?: number
  onBalanceChange?: (bal: number) => void
}) {
  const [txns, setTxns] = useState<BankTxn[]>([])
  const [candIn, setCandIn] = useState<MatchCandidate[]>([])
  const [candOut, setCandOut] = useState<MatchCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'unmatched' | 'matched' | 'ignored'>('unmatched')
  const [balance, setBalance] = useState<number | undefined>(currentBalance)
  const [sysBalance, setSysBalance] = useState<number | null>(null)   // 系统账面余额（日记账期初+全量逐笔）

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
  // 关联往来户·新建
  const [wlOpen, setWlOpen] = useState(false)
  const [wlCounter, setWlCounter] = useState('')
  const [wlCategory, setWlCategory] = useState('')
  const [wlSummary, setWlSummary] = useState('')
  const [wlSaving, setWlSaving] = useState(false)
  // 打开做账弹窗时，用性质路由预填 ② 直接记账（类别+对方，可改）——只读建议，财务确认
  useEffect(() => {
    if (!matchDialog) { setWlOpen(false); setWlCounter(''); setWlCategory(''); setWlSummary(''); return }
    const g = guessNature(matchDialog)
    setWlOpen(false); setWlSummary('')
    setWlCategory(g.category || '')
    setWlCounter(matchDialog.counterparty || '')
  }, [matchDialog])
  useEffect(() => { setBalance(currentBalance) }, [currentBalance])

  const loadTxns = useCallback(async (accId: string) => {
    setLoading(true)
    try {
      const [t, ci, co, j] = await Promise.all([getBankTransactions(accId), getMatchCandidates('in'), getMatchCandidates('out'), getJournal(accId)])
      setTxns(t); setCandIn(ci); setCandOut(co); setSysBalance(j.closing)
    } catch (e) { toast.error(`加载失败：${e instanceof Error ? e.message : '未知'}（若提示表不存在，请先执行迁移 20260612_bank_transactions.sql）`) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { if (accountId) loadTxns(accountId); else setLoading(false) }, [accountId, loadTxns])

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
      } else continue
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
      if (bal != null) { setBalance(bal); onBalanceChange?.(bal) }
    } catch (e) { toast.error(`导入失败：${e instanceof Error ? e.message : '未知'}`) }
    finally { setImporting(false) }
  }

  const confirmMatch = async (txn: BankTxn, cand: MatchCandidate) => {
    const type = candidateMatchedType(cand.source)
    const { error } = await matchBankTxn(txn.id, type, cand.id)
    if (error) { toast.error(`匹配失败：${error}`); return }
    toast.success(`已对账（${SOURCE_LABEL[cand.source]}）`)
    setTxns(prev => prev.map(t => t.id === txn.id ? { ...t, match_status: 'matched', matched_type: type, matched_id: cand.id, match_note: `${SOURCE_LABEL[cand.source]}·${cand.label}` } : t))
    setMatchDialog(null)
  }
  const doUnmatch = async (txn: BankTxn) => {
    const { error } = await unmatchBankTxn(txn.id)
    if (error) { toast.error(`取消失败：${error}`); return }
    setTxns(prev => prev.map(t => t.id === txn.id ? { ...t, match_status: 'unmatched', matched_id: null, matched_type: null } : t))
  }
  const doCreateWl = async () => {
    if (!matchDialog) return
    if (!wlCategory && !wlCounter.trim()) { toast.error('请选择类别，或填写对方/往来户'); return }
    setWlSaving(true)
    const { error } = await createManualAndMatch(matchDialog, { counterparty: wlCounter, category: wlCategory || null, summary: wlSummary || null })
    setWlSaving(false)
    if (error) { toast.error(`记账失败：${error}`); return }
    toast.success('已记账并对账')
    const note = ['做账', wlCategory, wlCounter.trim()].filter(Boolean).join('·')
    setTxns(prev => prev.map(t => t.id === matchDialog.id ? { ...t, match_status: 'matched', matched_type: 'manual', matched_id: null, match_note: note } : t))
    setMatchDialog(null)
    if (accountId) loadTxns(accountId)   // 刷新：新建的手工记账被认领，候选表同步
  }
  const doIgnore = async () => {
    if (!ignoreDialog || !ignoreNote.trim()) { toast.error('请填写忽略原因'); return }
    const { error } = await ignoreBankTxn(ignoreDialog.id, ignoreNote.trim())
    if (error) { toast.error(`操作失败：${error}`); return }
    setTxns(prev => prev.map(t => t.id === ignoreDialog.id ? { ...t, match_status: 'ignored', match_note: ignoreNote.trim() } : t))
    setIgnoreDialog(null); setIgnoreNote('')
  }

  const filtered = txns.filter(t => t.match_status === tab)
  // 余额校验（只读比对）：① 系统账面 vs 对账单余额；② 对账单逐日断链
  const dayBreaks = useMemo(() => checkStatementDays(txns), [txns])
  const balDiff = (sysBalance != null && balance != null) ? Math.round((sysBalance - balance) * 100) / 100 : null
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
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        {balance != null && <Badge variant="outline" className="text-sm">对账单余额 ¥{Number(balance || 0).toLocaleString()}</Badge>}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => accountId && loadTxns(accountId)}><RefreshCw className="h-4 w-4 mr-1" />刷新</Button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { onFile(e.target.files?.[0]); if (fileRef.current) fileRef.current.value = '' }} />
          <Button size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4 mr-1" />导入对账单</Button>
        </div>
      </div>

      {/* 余额校验（只读比对警示，不写库） */}
      {!loading && (balDiff != null || dayBreaks.length > 0) && (
        <div className="space-y-2">
          {balDiff != null && (
            <div className={`rounded-lg border px-3 py-2 text-sm flex items-center gap-3 flex-wrap ${Math.abs(balDiff) < 0.005 ? 'border-green-300 bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300' : 'border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300'}`}>
              <span className="font-medium">{Math.abs(balDiff) < 0.005 ? '✓ 余额校验通过' : '⚠ 余额对不上'}</span>
              <span className="tabular-nums">系统账面 ¥{sysBalance!.toLocaleString()}</span>
              <span className="tabular-nums">对账单 ¥{balance!.toLocaleString()}</span>
              {Math.abs(balDiff) >= 0.005 && <span className="tabular-nums font-semibold">差额 {balDiff > 0 ? '+' : ''}{balDiff.toLocaleString()}</span>}
              {Math.abs(balDiff) >= 0.005 && <span className="text-xs opacity-80">→ 差额=账面多记/漏记之和；先清「未对账」，再查日记账漏录（费用/转账用「做账」补）</span>}
            </div>
          )}
          {dayBreaks.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300 px-3 py-2 text-sm">
              <p className="font-medium">⚠ 对账单断链 {dayBreaks.length} 天（当日净额与余额列不衔接，疑漏导/重导）</p>
              <p className="text-xs mt-0.5 tabular-nums">{dayBreaks.slice(0, 6).map(b => `${b.date}（净${b.net >= 0 ? '+' : ''}${b.net.toLocaleString()}）`).join('、')}{dayBreaks.length > 6 ? ` 等 ${dayBreaks.length} 天` : ''}</p>
            </div>
          )}
        </div>
      )}

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
          <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>日期</TableHead><TableHead>收/付</TableHead><TableHead className="text-right">金额</TableHead>
              <TableHead>对方/摘要</TableHead><TableHead>建议匹配</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {filtered.map(t => {
                const cands = t.direction === 'in' ? candIn : candOut
                const sug = t.match_status === 'unmatched' ? suggestMatch(t, cands) : null
                const g = (t.match_status === 'unmatched' && !sug) ? guessNature(t) : null
                return (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs whitespace-nowrap">{t.txn_date}</TableCell>
                    <TableCell>{t.direction === 'in'
                      ? <span className="inline-flex items-center text-green-600 text-sm"><ArrowDownCircle className="h-4 w-4 mr-1" />收</span>
                      : <span className="inline-flex items-center text-red-600 text-sm"><ArrowUpCircle className="h-4 w-4 mr-1" />付</span>}</TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${t.direction === 'in' ? 'text-green-600' : 'text-red-600'}`}>¥{t.amount.toLocaleString()}</TableCell>
                    <TableCell className="text-xs max-w-[220px]"><span className="block truncate">{t.counterparty || '—'}</span><span className="block truncate text-muted-foreground">{t.summary || ''}</span></TableCell>
                    <TableCell className="text-xs">
                      {t.match_status === 'matched' ? <span className="text-green-700">已匹配{cands.find(c => c.id === t.matched_id)?.label ? `：${cands.find(c => c.id === t.matched_id)?.label}` : (t.match_note ? `：${t.match_note}` : '')}</span>
                        : t.match_status === 'ignored' ? <span className="text-muted-foreground">{t.match_note}</span>
                        : sug ? <span className="text-primary">{sug.label}</span>
                        : g?.label ? <span className="text-amber-600">疑似 {g.label} · 点「做账」</span>
                        : <span className="text-muted-foreground">无匹配候选</span>}
                    </TableCell>
                    <TableCell className="text-right space-x-1">
                      {t.match_status === 'unmatched' && <>
                        {sug && <Button size="sm" variant="outline" className="h-7" onClick={() => confirmMatch(t, sug)}><Link2 className="h-3 w-3 mr-1" />确认匹配</Button>}
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => setMatchDialog(t)}>做账</Button>
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
          </div>
        </Card>
      )}

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

      {/* 手动匹配 — 三来源候选 + 关联往来户新建 */}
      {matchDialog && (() => {
        const pool = (matchDialog.direction === 'in' ? candIn : candOut)
          .slice().sort((a, b) => Math.abs(a.amount - matchDialog.amount) - Math.abs(b.amount - matchDialog.amount))
        const groups: MatchCandidate['source'][] = matchDialog.direction === 'in' ? ['receivable', 'manual'] : ['supplier', 'manual']
        const g = guessNature(matchDialog)
        return (
          <Dialog open onOpenChange={() => setMatchDialog(null)}>
            <DialogContent className="sm:max-w-lg">
              <DialogHeader><DialogTitle>做账 — {matchDialog.direction === 'in' ? '收' : '付'} ¥{matchDialog.amount.toLocaleString()}（{matchDialog.txn_date}）{matchDialog.counterparty ? ` · ${matchDialog.counterparty}` : ''}</DialogTitle></DialogHeader>
              <div className="max-h-[60vh] overflow-y-auto space-y-3 py-2">
                {/* ① 关联已有系统单据 */}
                <p className="text-xs font-semibold text-foreground px-1">① 关联已有系统单据</p>
                {groups.map(src => {
                  const list = pool.filter(c => c.source === src).slice(0, 50)
                  return (
                    <div key={src}>
                      <p className="text-xs font-medium text-muted-foreground px-1 mb-1">{SOURCE_LABEL[src]}（{list.length}）</p>
                      {list.length === 0
                        ? <p className="text-xs text-muted-foreground px-3 py-1.5">无候选</p>
                        : list.map(c => (
                          <button key={c.id} className="w-full text-left px-3 py-2 rounded hover:bg-muted text-sm flex justify-between items-center" onClick={() => confirmMatch(matchDialog, c)}>
                            <span className="min-w-0"><span className="block truncate">{c.label}</span>{c.sub && <span className="block truncate text-xs text-muted-foreground">{c.sub}</span>}</span>
                            <span className="text-xs text-muted-foreground whitespace-nowrap ml-2">{c.date?.slice(0, 10)}</span>
                          </button>
                        ))}
                    </div>
                  )
                })}

                {/* ② 直接记账（无对应系统单据时） */}
                <div className="border-t pt-3">
                  <p className="text-xs font-semibold text-foreground px-1 mb-1">② 直接记账<span className="font-normal text-muted-foreground">（系统里没有对应单据：费用 / 往来 / 转账 / 其他）</span></p>
                  {g.label && <p className="text-xs text-amber-600 px-1 mb-1">系统按对方/摘要猜：{g.label}{g.category ? '（已预填类别，可改）' : g.kind === 'receivable' ? '，建议在 ① 客户回款里匹配' : g.kind === 'supplier' ? '，建议在 ① 供应商付款里匹配' : ''}</p>}
                  {!wlOpen ? (
                    <Button variant="outline" size="sm" className="w-full" onClick={() => setWlOpen(true)}>＋ 记为一笔账并对账</Button>
                  ) : (
                    <div className="space-y-2 rounded-lg border p-3 bg-muted/30">
                      <p className="text-xs text-muted-foreground">金额/日期/方向锁定按本条流水（{matchDialog.direction === 'in' ? '收' : '付'} ¥{matchDialog.amount.toLocaleString()}），只需选类别、补对方。</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1"><Label className="text-xs">类别 *</Label>
                          <Select value={wlCategory || '__none__'} onValueChange={v => setWlCategory(!v || v === '__none__' ? '' : v)}>
                            <SelectTrigger className="h-8"><SelectValue placeholder="选择类别" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">未指定</SelectItem>
                              {BOOK_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1"><Label className="text-xs">对方 / 往来户</Label><Input className="h-8" value={wlCounter} onChange={e => setWlCounter(e.target.value)} placeholder={matchDialog.counterparty || '如：秦总 / 供应商 / 银行'} /></div>
                      </div>
                      <div className="space-y-1"><Label className="text-xs">摘要（可选）</Label><Input className="h-8" value={wlSummary} onChange={e => setWlSummary(e.target.value)} placeholder={matchDialog.summary || '用途说明'} /></div>
                      <div className="flex gap-2 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setWlOpen(false)}>收起</Button>
                        <Button size="sm" onClick={doCreateWl} disabled={wlSaving}>{wlSaving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}记账并对账</Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )
      })()}

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
