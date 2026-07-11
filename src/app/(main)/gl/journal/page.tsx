'use client'

// ============================================================
// 记账凭证 — 查看 + 手工录入（草稿）+ 财务经理过账 + 打印
// 手工凭证：财务录入 → draft → 经理「过账」（post_journal 更新总账余额）。
// 打印：标准记账凭证版式（摘要/科目/借贷金额/合计大写/制单审核签栏）。
// ============================================================
import { useState, useEffect, useRef, useMemo } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, FileText, Eye, Download, Plus, Trash2, Printer, CheckCircle2 } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { bizToday } from '@/lib/biz-date'

type JournalEntry = {
  id: string
  voucher_no: string
  period_code: string
  voucher_date: string
  voucher_type: string
  description: string
  source_type: string | null
  total_debit: number
  total_credit: number
  status: string
  created_by: string | null
  created_at: string
}

type JournalLine = {
  id: string
  line_no: number
  account_code: string
  description: string | null
  debit: number
  credit: number
  accounts: { account_name: string } | null
}

type AccountOpt = { account_code: string; account_name: string }
type EntryLine = { account_code: string; account_name: string; description: string; debit: string; credit: string }

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'bg-gray-100 text-gray-700' },
  posted: { label: '已过账', color: 'bg-green-100 text-green-700' },
  voided: { label: '已作废', color: 'bg-red-100 text-red-700' },
}

const TYPE_MAP: Record<string, string> = { auto: '自动', manual: '手工', closing: '结转' }
const SOURCE_MAP: Record<string, string> = { budget_order: '订单审批', settlement: '订单决算', receipt: '收款', payment: '付款', manual: '手工' }

// 双主体打印抬头：全称可在打印弹窗改，改后记住（localStorage）
const ENTITIES_KEY = 'voucher-print-entities'
const DEFAULT_ENTITIES = ['义乌市绮陌服饰有限公司', '傲狐（请补全公司全称）']
function loadEntities(): string[] {
  try {
    const raw = localStorage.getItem(ENTITIES_KEY)
    const arr = raw ? JSON.parse(raw) : null
    if (Array.isArray(arr) && arr.length === 2 && arr.every(x => typeof x === 'string')) return arr
  } catch { /* 解析失败回默认 */ }
  return [...DEFAULT_ENTITIES]
}
function saveEntities(list: string[]) {
  try { localStorage.setItem(ENTITIES_KEY, JSON.stringify(list)) } catch { /* 存不了就下次再填 */ }
}

const r2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 人民币大写（从分起算，避免浮点误差） */
function cnMoney(n: number): string {
  const neg = n < 0
  const cents = Math.round(Math.abs(n) * 100)
  if (cents === 0) return '零元整'
  const digit = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
  const unit = [['元', '万', '亿'], ['', '拾', '佰', '仟']]
  const jiao = Math.floor(cents / 10) % 10
  const fen = cents % 10
  let s = ''
  if (fen) s = digit[fen] + '分'
  if (jiao) s = digit[jiao] + '角' + s
  else if (fen) s = '零' + s        // 有分无角：X元零X分
  let iv = Math.floor(cents / 100)
  if (iv === 0) { s = s.replace(/^零/, '') }  // 不足1元：角分打头不带零
  else {
    let intStr = ''
    for (let i = 0; i < unit[0].length && iv > 0; i++) {
      let p = ''
      for (let j = 0; j < unit[1].length && iv > 0; j++) {
        p = digit[iv % 10] + unit[1][j] + p
        iv = Math.floor(iv / 10)
      }
      intStr = p.replace(/(零.)*零$/, '').replace(/^$/, '零') + unit[0][i] + intStr
    }
    intStr = intStr.replace(/(零.)*零元/, '元').replace(/(零.)+/g, '零')
    s = intStr + (s || '整')
  }
  return (neg ? '负' : '') + s
}

function exportJournalCSV(period: string, entries: JournalEntry[]) {
  const headers = ['凭证号', '日期', '类型', '摘要', '来源', '借方合计', '贷方合计', '状态']
  const rows = entries.map(e => [
    e.voucher_no, e.voucher_date,
    TYPE_MAP[e.voucher_type] || e.voucher_type,
    `"${e.description.replace(/"/g, '""')}"`,
    SOURCE_MAP[e.source_type || ''] || e.source_type || '',
    e.total_debit, e.total_credit,
    STATUS_MAP[e.status]?.label || e.status,
  ].join(','))
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `记账凭证_${period}.csv`
  a.click()
  URL.revokeObjectURL(url)
  toast.success('凭证列表已导出')
}

/** 打印凭证：新窗口渲染标准记账凭证版式并调起打印（company=打印抬头，双主体在弹窗选） */
function printVoucher(entry: JournalEntry, lines: JournalLine[], creatorName: string, company: string) {
  const minRows = Math.max(lines.length, 4)
  const rowsHtml = Array.from({ length: minRows }, (_, i) => {
    const l = lines[i]
    return l ? `<tr>
      <td class="desc">${(l.description || entry.description || '').replace(/</g, '&lt;')}</td>
      <td class="acct">${l.account_code} ${(l.accounts?.account_name || '').replace(/</g, '&lt;')}</td>
      <td class="num">${l.debit > 0 ? money(l.debit) : ''}</td>
      <td class="num">${l.credit > 0 ? money(l.credit) : ''}</td>
    </tr>` : '<tr><td class="desc">&nbsp;</td><td class="acct"></td><td class="num"></td><td class="num"></td></tr>'
  }).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>记账凭证 ${entry.voucher_no}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "SimSun","Songti SC",serif; padding: 24px 32px; color: #000; }
  .company { text-align: center; font-size: 14px; letter-spacing: 2px; }
  h1 { text-align: center; font-size: 22px; letter-spacing: 12px; margin: 6px 0 2px; }
  .rule { border-bottom: 2px solid #000; margin: 2px auto 10px; width: 200px; position: relative; }
  .rule::after { content: ''; display: block; border-bottom: 1px solid #000; margin-top: 2px; }
  .meta { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #000; font-size: 12px; padding: 6px 8px; }
  th { font-weight: normal; text-align: center; }
  td.desc { width: 34%; }
  td.acct { width: 36%; }
  td.num { width: 15%; text-align: right; font-family: "SimSun",monospace; }
  tr.total td { font-weight: bold; }
  .footer { display: flex; justify-content: space-between; font-size: 12px; margin-top: 12px; }
  @media print { body { padding: 12px 16px; } }
</style></head><body>
  <p class="company">${company.replace(/</g, '&lt;')}</p>
  <h1>记账凭证</h1>
  <div class="rule"></div>
  <div class="meta">
    <span>日期：${entry.voucher_date}</span>
    <span>凭证号：${entry.voucher_no}</span>
    <span>状态：${STATUS_MAP[entry.status]?.label || entry.status}</span>
    <span>附单据&nbsp;&nbsp;&nbsp;&nbsp;张</span>
  </div>
  <table>
    <thead><tr><th>摘要</th><th>会计科目</th><th>借方金额</th><th>贷方金额</th></tr></thead>
    <tbody>
      ${rowsHtml}
      <tr class="total">
        <td colspan="2">合计：人民币（大写）${cnMoney(entry.total_debit)}</td>
        <td class="num">${money(entry.total_debit)}</td>
        <td class="num">${money(entry.total_credit)}</td>
      </tr>
    </tbody>
  </table>
  <div class="footer">
    <span>财务主管：__________</span>
    <span>记账：__________</span>
    <span>审核：__________</span>
    <span>制单：${creatorName || '__________'}</span>
  </div>
  <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 100); };</script>
</body></html>`
  const w = window.open('', '_blank', 'width=920,height=640')
  if (!w) { toast.error('浏览器拦截了打印窗口，请允许弹出窗口后重试'); return }
  w.document.write(html)
  w.document.close()
}

// ── 科目选择器（输入过滤下拉；科目多，Select 不好用） ──
function AccountPicker({ accounts, value, display, onPick }: {
  accounts: AccountOpt[]; value: string; display: string
  onPick: (a: AccountOpt | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [kw, setKw] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])
  const list = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return accounts.slice(0, 50)
    return accounts.filter(a => a.account_code.includes(k) || a.account_name.toLowerCase().includes(k)).slice(0, 50)
  }, [accounts, kw])
  return (
    <div ref={boxRef} className="relative">
      <Input
        className="h-8 text-xs"
        placeholder="输入科目编码/名称搜索"
        value={open ? kw : (value ? display : '')}
        onFocus={() => { setOpen(true); setKw('') }}
        onChange={e => { setKw(e.target.value); if (!open) setOpen(true) }}
      />
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto rounded-md border bg-popover shadow-md">
          {list.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">无匹配科目</p>}
          {list.map(a => (
            <button key={a.account_code} type="button"
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted font-mono"
              onClick={() => { onPick(a); setOpen(false) }}>
              {a.account_code} <span className="font-sans">{a.account_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function JournalPage() {
  const [period, setPeriod] = useState('')
  const [periods, setPeriods] = useState<string[]>([])
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<{ entry: JournalEntry; lines: JournalLine[] } | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})

  // 录入凭证
  const [entryOpen, setEntryOpen] = useState(false)
  const [accounts, setAccounts] = useState<AccountOpt[]>([])
  const [eDate, setEDate] = useState('')
  const [eDesc, setEDesc] = useState('')
  const emptyLine = (): EntryLine => ({ account_code: '', account_name: '', description: '', debit: '', credit: '' })
  const [eLines, setELines] = useState<EntryLine[]>([emptyLine(), emptyLine()])
  const [saving, setSaving] = useState(false)
  const [postingId, setPostingId] = useState<string | null>(null)

  // 打印：先选抬头（双主体），全称可改并记住
  const [printTarget, setPrintTarget] = useState<{ entry: JournalEntry; lines: JournalLine[] } | null>(null)
  const [entities, setEntities] = useState<string[]>(DEFAULT_ENTITIES)
  useEffect(() => { setEntities(loadEntities()) }, [])

  const loadEntries = async (p: string) => {
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase
      .from('journal_entries')
      .select('*')
      .eq('period_code', p)
      .order('voucher_no')
    const list = (data as JournalEntry[]) || []
    setEntries(list)
    // 制单人姓名（打印用）
    const ids = [...new Set(list.map(e => e.created_by).filter(Boolean))] as string[]
    if (ids.length) {
      const { data: ps } = await supabase.from('profiles').select('id, name, email').in('id', ids)
      setNames(Object.fromEntries((ps || []).map(x => [x.id as string, (x.name as string) || (x.email as string) || ''])))
    }
    setLoading(false)
  }

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data } = await supabase.from('accounting_periods').select('period_code').order('period_code', { ascending: false })
      if (data?.length) {
        const codes = data.map(x => x.period_code as string)
        setPeriods(codes)
        const current = new Date().toISOString().substring(0, 7)
        setPeriod(codes.find(c => c === current) || codes[0])
      }
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => { if (period) loadEntries(period) }, [period])

  const handleViewDetail = async (entry: JournalEntry) => {
    const supabase = createClient()
    const { data } = await supabase
      .from('journal_lines')
      .select('*, accounts(account_name)')
      .eq('journal_id', entry.id)
      .order('line_no')
    setDetail({ entry, lines: (data as JournalLine[]) || [] })
  }

  const handlePrint = async (entry: JournalEntry) => {
    const supabase = createClient()
    const { data } = await supabase
      .from('journal_lines')
      .select('*, accounts(account_name)')
      .eq('journal_id', entry.id)
      .order('line_no')
    setPrintTarget({ entry, lines: (data as JournalLine[]) || [] })
  }

  const doPrint = (idx: number) => {
    if (!printTarget) return
    const company = entities[idx]?.trim()
    if (!company) { toast.error('请填写公司抬头全称'); return }
    saveEntities(entities)   // 记住改过的全称
    printVoucher(printTarget.entry, printTarget.lines, names[printTarget.entry.created_by || ''] || '', company)
    setPrintTarget(null)
  }

  // ── 录入凭证 ──
  const openEntry = async () => {
    setEDate(bizToday()); setEDesc(''); setELines([emptyLine(), emptyLine()]); setEntryOpen(true)
    if (accounts.length === 0) {
      const supabase = createClient()
      const { data } = await supabase.from('accounts')
        .select('account_code, account_name')
        .eq('is_active', true).eq('is_detail', true)
        .order('account_code').limit(2000)
      setAccounts((data as AccountOpt[]) || [])
    }
  }

  const setLine = (i: number, patch: Partial<EntryLine>) => setELines(ls => ls.map((l, j) => j === i ? { ...l, ...patch } : l))
  const totals = useMemo(() => {
    const d = r2(eLines.reduce((s, l) => s + (Number(l.debit) || 0), 0))
    const c = r2(eLines.reduce((s, l) => s + (Number(l.credit) || 0), 0))
    return { d, c, balanced: Math.abs(d - c) < 0.005 && d > 0 }
  }, [eLines])

  const saveEntry = async () => {
    if (!eDesc.trim()) { toast.error('请填写凭证摘要'); return }
    const lines = eLines.filter(l => l.account_code && ((Number(l.debit) || 0) !== 0 || (Number(l.credit) || 0) !== 0))
    if (lines.length < 2) { toast.error('至少需要两条有效分录（一借一贷）'); return }
    if (!totals.balanced) { toast.error(`借贷不平衡：借 ${money(totals.d)} ≠ 贷 ${money(totals.c)}`); return }
    setSaving(true)
    try {
      const res = await fetch('/api/gl/journal/manual', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: eDate, description: eDesc.trim(),
          lines: lines.map(l => ({ account_code: l.account_code, description: l.description.trim(), debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
        }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || '录入失败')
      toast.success(`已保存凭证 ${j.voucher_no}（草稿，待财务经理过账）`)
      setEntryOpen(false)
      const p = eDate.slice(0, 7)
      if (p !== period && periods.includes(p)) setPeriod(p)
      else loadEntries(period)
    } catch (e) { toast.error(e instanceof Error ? e.message : '录入失败') }
    finally { setSaving(false) }
  }

  const postEntry = async (entry: JournalEntry) => {
    if (!confirm(`确认过账凭证 ${entry.voucher_no}（¥${money(entry.total_debit)}）？过账后计入总账余额。`)) return
    setPostingId(entry.id)
    try {
      const res = await fetch(`/api/gl/journal/${entry.id}/post`, { method: 'POST' })
      const j = await res.json()
      if (!res.ok) throw new Error(res.status === 403 ? '仅财务经理/管理员可过账（草稿已保存，请经理复核）' : (j.error || '过账失败'))
      toast.success(`凭证 ${entry.voucher_no} 已过账`)
      loadEntries(period)
    } catch (e) { toast.error(e instanceof Error ? e.message : '过账失败') }
    finally { setPostingId(null) }
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="记账凭证" subtitle="自动生成 + 手工录入（草稿→财务经理过账）· 可打印" />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <Select value={period} onValueChange={v => setPeriod(v || '')}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="选择期间" /></SelectTrigger>
            <SelectContent>
              {periods.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">共 {entries.length} 张凭证</p>
            {entries.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => exportJournalCSV(period, entries)}>
                <Download className="h-4 w-4 mr-1" />导出CSV
              </Button>
            )}
            <Button size="sm" onClick={openEntry}><Plus className="h-4 w-4 mr-1" />录入凭证</Button>
          </div>
        </div>

        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : entries.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>该期间暂无凭证</p>
                <p className="text-xs mt-1">点右上「录入凭证」手工做账；业务单据（订单/收付款）审批后也会自动生成凭证</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>凭证号</TableHead>
                    <TableHead>日期</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>摘要</TableHead>
                    <TableHead>来源</TableHead>
                    <TableHead className="text-right">借方</TableHead>
                    <TableHead className="text-right">贷方</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map(e => {
                    const sc = STATUS_MAP[e.status] || STATUS_MAP.draft
                    return (
                      <TableRow key={e.id}>
                        <TableCell className="font-mono text-sm font-medium">{e.voucher_no}</TableCell>
                        <TableCell className="text-sm">{e.voucher_date}</TableCell>
                        <TableCell><Badge variant="outline" className="text-[10px]">{TYPE_MAP[e.voucher_type] || e.voucher_type}</Badge></TableCell>
                        <TableCell className="max-w-[200px] truncate">{e.description}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{SOURCE_MAP[e.source_type || ''] || e.source_type || '-'}</TableCell>
                        <TableCell className="text-right font-medium">¥{e.total_debit.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-medium">¥{e.total_credit.toLocaleString()}</TableCell>
                        <TableCell><Badge className={`${sc.color} border-0 text-[10px]`}>{sc.label}</Badge></TableCell>
                        <TableCell className="text-center whitespace-nowrap">
                          {e.status === 'draft' && (
                            <Button size="sm" variant="outline" className="h-7 mr-1" disabled={postingId === e.id} onClick={() => postEntry(e)}>
                              {postingId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><CheckCircle2 className="h-3.5 w-3.5 mr-1" />过账</>}
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => handleViewDetail(e)}><Eye className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="ghost" className="h-7" title="打印凭证" onClick={() => handlePrint(e)}><Printer className="h-3.5 w-3.5" /></Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 录入凭证 */}
      <Dialog open={entryOpen} onOpenChange={setEntryOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader><DialogTitle>录入凭证（保存为草稿，财务经理过账后计入总账）</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1"><Label className="text-xs">日期</Label><Input type="date" className="h-8" value={eDate} onChange={e => setEDate(e.target.value)} /></div>
              <div className="space-y-1 col-span-2"><Label className="text-xs">凭证摘要 *</Label><Input className="h-8" value={eDesc} onChange={e => setEDesc(e.target.value)} placeholder="如：1022849订单杭州秀尔付傲狐工行货款" /></div>
            </div>
            <div className="rounded-md border overflow-visible">
              <div className="grid grid-cols-[1fr_170px_120px_120px_32px] gap-2 px-2 py-1.5 text-xs text-muted-foreground border-b bg-muted/40">
                <span>会计科目 *</span><span>行摘要（默认同凭证摘要）</span><span className="text-right">借方金额</span><span className="text-right">贷方金额</span><span />
              </div>
              <div className="space-y-1.5 p-2">
                {eLines.map((l, i) => (
                  <div key={i} className="grid grid-cols-[1fr_170px_120px_120px_32px] gap-2 items-center">
                    <AccountPicker
                      accounts={accounts}
                      value={l.account_code}
                      display={l.account_code ? `${l.account_code} ${l.account_name}` : ''}
                      onPick={a => setLine(i, a ? { account_code: a.account_code, account_name: a.account_name } : { account_code: '', account_name: '' })}
                    />
                    <Input className="h-8 text-xs" value={l.description} onChange={e => setLine(i, { description: e.target.value })} placeholder={eDesc || '摘要'} />
                    <Input className="h-8 text-xs text-right" type="number" step="0.01" value={l.debit} onChange={e => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} placeholder="0.00" />
                    <Input className="h-8 text-xs text-right" type="number" step="0.01" value={l.credit} onChange={e => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} placeholder="0.00" />
                    <Button size="sm" variant="ghost" className="h-8 px-1 text-muted-foreground" disabled={eLines.length <= 2} onClick={() => setELines(ls => ls.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setELines(ls => [...ls, emptyLine()])}><Plus className="h-3 w-3 mr-1" />加一行</Button>
              </div>
              <div className={`flex items-center justify-end gap-4 px-3 py-2 border-t text-sm ${totals.balanced ? 'text-green-700' : 'text-red-600'}`}>
                <span>借方合计 ¥{money(totals.d)}</span>
                <span>贷方合计 ¥{money(totals.c)}</span>
                <span className="font-medium">{totals.balanced ? '✓ 平衡' : totals.d === 0 && totals.c === 0 ? '未录入' : `差额 ¥${money(Math.abs(totals.d - totals.c))}`}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEntryOpen(false)}>取消</Button>
            <Button onClick={saveEntry} disabled={saving || !totals.balanced}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}保存草稿</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 打印：选主体抬头（全称可改，改后记住） */}
      {printTarget && (
        <Dialog open onOpenChange={() => setPrintTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>打印凭证 {printTarget.entry.voucher_no} — 选择公司抬头</DialogTitle></DialogHeader>
            <div className="space-y-2 py-1">
              <p className="text-xs text-muted-foreground">抬头全称可直接修改，修改后会记住；点「打印」立即出单。</p>
              {entities.map((name, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input className="h-9" value={name} onChange={e => setEntities(list => list.map((x, j) => j === i ? e.target.value : x))} placeholder={i === 0 ? '主体一全称' : '主体二全称'} />
                  <Button size="sm" className="h-9 whitespace-nowrap" onClick={() => doPrint(i)}><Printer className="h-4 w-4 mr-1" />打印</Button>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* 凭证明细弹窗 */}
      {detail && (
        <Dialog open onOpenChange={() => setDetail(null)}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>凭证 {detail.entry.voucher_no}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="flex gap-4 text-muted-foreground">
                <span>日期: {detail.entry.voucher_date}</span>
                <span>类型: {TYPE_MAP[detail.entry.voucher_type]}</span>
                <span>来源: {SOURCE_MAP[detail.entry.source_type || ''] || '-'}</span>
                <span>制单: {names[detail.entry.created_by || ''] || '-'}</span>
              </div>
              <p className="font-medium">{detail.entry.description}</p>
              <Separator />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>序号</TableHead>
                    <TableHead>科目</TableHead>
                    <TableHead>摘要</TableHead>
                    <TableHead className="text-right">借方</TableHead>
                    <TableHead className="text-right">贷方</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.lines.map(l => (
                    <TableRow key={l.id}>
                      <TableCell>{l.line_no}</TableCell>
                      <TableCell className="font-mono">{l.account_code} {l.accounts?.account_name || ''}</TableCell>
                      <TableCell className="text-muted-foreground">{l.description || '-'}</TableCell>
                      <TableCell className="text-right font-medium">{l.debit > 0 ? `¥${l.debit.toLocaleString()}` : ''}</TableCell>
                      <TableCell className="text-right font-medium">{l.credit > 0 ? `¥${l.credit.toLocaleString()}` : ''}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="font-bold bg-muted/30">
                    <TableCell colSpan={3} className="text-right">合计（大写：{cnMoney(detail.entry.total_debit)}）</TableCell>
                    <TableCell className="text-right">¥{detail.entry.total_debit.toLocaleString()}</TableCell>
                    <TableCell className="text-right">¥{detail.entry.total_credit.toLocaleString()}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => setPrintTarget({ entry: detail.entry, lines: detail.lines })}>
                  <Printer className="h-4 w-4 mr-1" />打印凭证
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
