'use client'

// ============================================================
// 日记账 Tab（合并页 · 由父级共享账户驱动）
// 企业侧现金流水账：收付自动汇入 + 手工补录 + 逐笔余额。账户选择在父级。
// ============================================================
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2, Plus, Pencil, Trash2, Wallet, Settings, Download, Link2, BookOpen, ArrowLeftRight } from 'lucide-react'
import { toast } from 'sonner'
import { bizToday } from '@/lib/biz-date'
import {
  getJournal, upsertAccount, createManualEntry, updateManualEntry, deleteManualEntry, createTransfer,
  getUnassigned, assignAccount, ACCOUNT_TYPE_LABEL, MANUAL_CATEGORIES,
  type JournalAccount, type JournalResult, type JournalRow,
} from '@/lib/supabase/bank-journal'

const money = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const SOURCE_LABEL: Record<string, string> = { manual: '手工', receipt: '回款', payment: '付款' }

export function JournalTab({ accountId, account, accounts, reloadAccounts }: {
  accountId: string
  account: JournalAccount | null
  accounts: JournalAccount[]
  reloadAccounts: () => Promise<void>
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [journal, setJournal] = useState<JournalResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // 手工记一笔
  const [entryOpen, setEntryOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [eDate, setEDate] = useState('')
  const [eDir, setEDir] = useState<'in' | 'out'>('out')
  const [eAmount, setEAmount] = useState('')
  const [eCategory, setECategory] = useState('')
  const [eCounter, setECounter] = useState('')
  const [eSummary, setESummary] = useState('')
  const [eRef, setERef] = useState('')
  const [saving, setSaving] = useState(false)

  const [acctOpen, setAcctOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)

  const loadJournal = useCallback(async () => {
    if (!accountId) { setJournal(null); setLoading(false); return }
    setRefreshing(true)
    const j = await getJournal(accountId, from || undefined, to || undefined)
    setJournal(j); setLoading(false); setRefreshing(false)
  }, [accountId, from, to])

  useEffect(() => { loadJournal() }, [loadJournal])

  function openNewEntry() {
    setEditId(null); setEDate(bizToday()); setEDir('out'); setEAmount(''); setECategory(''); setECounter(''); setESummary(''); setERef(''); setEntryOpen(true)
  }
  function openEditEntry(r: JournalRow) {
    setEditId(r.sourceId); setEDate(r.date); setEDir(r.direction); setEAmount(String(r.amount))
    setECategory(r.category || ''); setECounter(r.counterparty || ''); setESummary(r.summary || ''); setERef(r.reference || ''); setEntryOpen(true)
  }

  async function saveEntry() {
    if (!accountId) { toast.error('请先选择账户'); return }
    const amt = Number(eAmount)
    if (!eAmount || Number.isNaN(amt) || amt <= 0) { toast.error('请输入有效金额'); return }
    if (!eDate) { toast.error('请选择日期'); return }
    setSaving(true)
    const payload = { txn_date: eDate, direction: eDir, amount: amt, currency: account?.currency || 'CNY', category: eCategory || null, counterparty: eCounter, summary: eSummary, reference: eRef }
    const { error } = editId
      ? await updateManualEntry(editId, payload)
      : await createManualEntry({ bank_account_id: accountId, ...payload })
    setSaving(false)
    if (error) { toast.error(`保存失败：${error}`); return }
    toast.success(editId ? '已更新' : '已记账')
    setEntryOpen(false); await loadJournal()
  }

  async function removeEntry(r: JournalRow) {
    if (!confirm(`确认删除这笔手工记账（${r.date} ${r.summary || ''} ${money(r.amount)}）？`)) return
    const { error } = await deleteManualEntry(r.sourceId)
    if (error) { toast.error(`删除失败：${error}`); return }
    toast.success('已删除'); await loadJournal()
  }

  function exportCsv() {
    if (!journal || !account) return
    const head = ['日期', '摘要', '对方单位', '类别', '收入', '支出', '余额', '来源', '凭证号']
    const lines = journal.rows.map(r => [
      r.date, r.summary || '', r.counterparty || '', r.category || '',
      r.direction === 'in' ? r.amount : '', r.direction === 'out' ? r.amount : '', r.balance,
      SOURCE_LABEL[r.source], r.reference || '',
    ])
    const csv = [
      `账户,${account.account_name}（${account.currency}）`,
      `期初余额,${journal.opening}${journal.openingDate ? '  截至 ' + journal.openingDate : ''}`,
      head.join(','),
      ...lines.map(l => l.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')),
      `本期收入,${journal.totalIn},,本期支出,${journal.totalOut},期末余额,${journal.closing}`,
    ].join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `银行日记账_${account.account_name}_${from || ''}_${to || ''}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1"><Label className="text-xs">起</Label><Input type="date" className="w-[150px]" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">止</Label><Input type="date" className="w-[150px]" value={to} onChange={e => setTo(e.target.value)} /></div>
        <div className="flex items-center gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}><Link2 className="h-4 w-4 mr-1" />未归集收付</Button>
          <Button variant="outline" size="sm" onClick={() => setAcctOpen(true)}><Settings className="h-4 w-4 mr-1" />管理账户</Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!journal || journal.rows.length === 0}><Download className="h-4 w-4 mr-1" />导出</Button>
          <Button variant="outline" size="sm" onClick={() => setTransferOpen(true)} disabled={!accountId}><ArrowLeftRight className="h-4 w-4 mr-1" />转账/结汇</Button>
          <Button size="sm" onClick={openNewEntry} disabled={!accountId}><Plus className="h-4 w-4 mr-1" />记一笔</Button>
        </div>
      </div>

      {/* 汇总卡 */}
      {journal && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">期初余额{journal.openingDate ? `（${journal.openingDate}）` : ''}</p><p className="text-xl font-bold mt-1">{account?.currency} {money(journal.opening)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">本期收入</p><p className="text-xl font-bold mt-1 text-green-600">+{money(journal.totalIn)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">本期支出</p><p className="text-xl font-bold mt-1 text-red-600">-{money(journal.totalOut)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">期末余额</p><p className="text-xl font-bold mt-1">{account?.currency} {money(journal.closing)}</p></CardContent></Card>
        </div>
      )}

      {/* 明细 */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : !accountId ? (
            <div className="text-center py-20 text-muted-foreground"><Wallet className="h-12 w-12 mx-auto mb-3 opacity-30" /><p>请先“管理账户”新建一个账户（银行/支付宝/微信/现金）</p></div>
          ) : !journal || journal.rows.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground"><BookOpen className="h-12 w-12 mx-auto mb-3 opacity-30" /><p>该账户在所选期间暂无流水</p><p className="text-xs mt-1">收款/付款会自动汇入（需先“未归集收付”归到本账户）；其他现金动作用“记一笔”</p></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">日期</TableHead>
                  <TableHead>摘要</TableHead>
                  <TableHead>对方单位</TableHead>
                  <TableHead>类别</TableHead>
                  <TableHead className="text-right">收入</TableHead>
                  <TableHead className="text-right">支出</TableHead>
                  <TableHead className="text-right">余额</TableHead>
                  <TableHead className="text-center">来源</TableHead>
                  <TableHead className="text-center w-[90px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {journal.rows.map(r => (
                  <TableRow key={r.key}>
                    <TableCell className="text-sm">{r.date}</TableCell>
                    <TableCell className="text-sm">{r.summary || '-'}</TableCell>
                    <TableCell className="text-sm">{r.counterparty || '-'}</TableCell>
                    <TableCell className="text-sm">{r.category || '-'}</TableCell>
                    <TableCell className="text-right text-sm text-green-600 font-medium">{r.direction === 'in' ? money(r.amount) : ''}</TableCell>
                    <TableCell className="text-right text-sm text-red-600 font-medium">{r.direction === 'out' ? money(r.amount) : ''}</TableCell>
                    <TableCell className="text-right text-sm font-semibold">{money(r.balance)}</TableCell>
                    <TableCell className="text-center"><Badge variant={r.source === 'manual' ? 'secondary' : 'outline'} className="text-[10px]">{SOURCE_LABEL[r.source]}</Badge></TableCell>
                    <TableCell className="text-center">
                      {r.editable ? (
                        <div className="flex items-center justify-center gap-1">
                          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => openEditEntry(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-red-600" onClick={() => removeEntry(r)}><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      ) : <span className="text-[10px] text-muted-foreground">自动</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {refreshing && <p className="text-xs text-muted-foreground text-center">刷新中…</p>}

      {/* 记一笔 弹窗 */}
      <Dialog open={entryOpen} onOpenChange={setEntryOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editId ? '编辑记账' : '记一笔'}（{account?.account_name}）</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>日期</Label><Input type="date" value={eDate} onChange={e => setEDate(e.target.value)} /></div>
              <div className="space-y-1"><Label>收/支</Label>
                <Select value={eDir} onValueChange={v => setEDir((v as 'in' | 'out') || 'out')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="in">收入（进账）</SelectItem><SelectItem value="out">支出（出账）</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>金额（{account?.currency}）</Label><Input type="number" step="0.01" value={eAmount} onChange={e => setEAmount(e.target.value)} placeholder="0.00" /></div>
              <div className="space-y-1"><Label>类别</Label>
                <Select value={eCategory || '__none__'} onValueChange={v => setECategory(!v || v === '__none__' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder="选择类别" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">未指定</SelectItem>
                    {MANUAL_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1"><Label>对方单位（可选）</Label><Input value={eCounter} onChange={e => setECounter(e.target.value)} placeholder="收/付对象" /></div>
            <div className="space-y-1"><Label>摘要（可选）</Label><Input value={eSummary} onChange={e => setESummary(e.target.value)} placeholder="用途说明" /></div>
            <div className="space-y-1"><Label>凭证号（可选）</Label><Input value={eRef} onChange={e => setERef(e.target.value)} placeholder="银行流水号/凭证号" /></div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEntryOpen(false)}>取消</Button>
            <Button onClick={saveEntry} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}{editId ? '保存' : '记账'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <AccountManager open={acctOpen} onOpenChange={setAcctOpen} accounts={accounts} onChanged={async () => { await reloadAccounts(); await loadJournal() }} />
      <UnassignedManager open={assignOpen} onOpenChange={setAssignOpen} accounts={accounts} onChanged={loadJournal} />
      <TransferDialog open={transferOpen} onOpenChange={setTransferOpen} accounts={accounts} defaultFrom={accountId} onDone={async () => { await reloadAccounts(); await loadJournal() }} />
    </div>
  )
}

// ── 账户管理 ─────────────────────────────
function AccountManager({ open, onOpenChange, accounts, onChanged }: {
  open: boolean; onOpenChange: (o: boolean) => void; accounts: JournalAccount[]; onChanged: () => void
}) {
  const [editing, setEditing] = useState<Partial<JournalAccount> | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (!open) setEditing(null) }, [open])

  async function save() {
    if (!editing?.account_name?.trim()) { toast.error('请填写账户名称'); return }
    setSaving(true)
    const { error } = await upsertAccount(editing as JournalAccount & { account_name: string })
    setSaving(false)
    if (error) { toast.error(`保存失败：${error}`); return }
    toast.success('已保存'); setEditing(null); onChanged()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>管理账户</DialogTitle></DialogHeader>
        {editing ? (
          <div className="space-y-3 py-2">
            <div className="space-y-1"><Label>账户名称 *</Label><Input value={editing.account_name || ''} onChange={e => setEditing({ ...editing, account_name: e.target.value })} placeholder="如：工行对公 / 支付宝 / 现金" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>类型</Label>
                <Select value={editing.account_type || 'bank'} onValueChange={v => setEditing({ ...editing, account_type: (v as JournalAccount['account_type']) })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{(['bank', 'alipay', 'wechat', 'cash'] as const).map(t => <SelectItem key={t} value={t}>{ACCOUNT_TYPE_LABEL[t]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1"><Label>币种</Label><Input value={editing.currency || 'CNY'} onChange={e => setEditing({ ...editing, currency: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>开户行（可选）</Label><Input value={editing.bank_name || ''} onChange={e => setEditing({ ...editing, bank_name: e.target.value })} /></div>
              <div className="space-y-1"><Label>账号（可选）</Label><Input value={editing.account_number || ''} onChange={e => setEditing({ ...editing, account_number: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>期初余额</Label><Input type="number" step="0.01" value={editing.opening_balance ?? 0} onChange={e => setEditing({ ...editing, opening_balance: Number(e.target.value) })} /></div>
              <div className="space-y-1"><Label>期初日期</Label><Input type="date" value={editing.opening_date || ''} onChange={e => setEditing({ ...editing, opening_date: e.target.value })} /></div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editing.is_active ?? true} onChange={e => setEditing({ ...editing, is_active: e.target.checked })} />启用</label>
            <div className="flex gap-2 pt-1">
              <Button variant="outline" onClick={() => setEditing(null)}>返回</Button>
              <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}保存</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 py-2">
            <Button size="sm" onClick={() => setEditing({ account_type: 'bank', currency: 'CNY', opening_balance: 0, is_active: true })}><Plus className="h-4 w-4 mr-1" />新建账户</Button>
            <div className="space-y-1">
              {accounts.length === 0 && <p className="text-sm text-muted-foreground py-4 text-center">暂无账户</p>}
              {accounts.map(a => (
                <div key={a.id} className="flex items-center justify-between p-2 rounded-lg border text-sm">
                  <div>
                    <span className="font-medium">{a.account_name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{a.account_type ? ACCOUNT_TYPE_LABEL[a.account_type] : ''} · {a.currency} · 期初 {money(a.opening_balance)}{!a.is_active ? ' · 已停用' : ''}</span>
                  </div>
                  <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => setEditing(a)}><Pencil className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── 未归集收付 ─────────────────────────────
function UnassignedManager({ open, onOpenChange, accounts, onChanged }: {
  open: boolean; onOpenChange: (o: boolean) => void; accounts: JournalAccount[]; onChanged: () => void
}) {
  const [data, setData] = useState<{ receipts: Record<string, unknown>[]; payments: Record<string, unknown>[] }>({ receipts: [], payments: [] })
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState('')

  const reload = useCallback(async () => { setLoading(true); setData(await getUnassigned()); setLoading(false) }, [])
  useEffect(() => { if (open) { reload(); setTarget(accounts.find(a => a.is_active)?.id || '') } }, [open, reload, accounts])

  async function assign(source: 'receipt' | 'payment', id: string) {
    if (!target) { toast.error('请先选择归入的账户'); return }
    const { error } = await assignAccount(source, id, target)
    if (error) { toast.error(`归集失败：${error}`); return }
    toast.success('已归入账户'); await reload(); onChanged()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto max-w-2xl">
        <DialogHeader><DialogTitle>未归集收付流水</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <span>归入账户：</span>
            <Select value={target} onValueChange={v => setTarget(v || '')}>
              <SelectTrigger className="w-[220px]"><SelectValue placeholder="选择账户" /></SelectTrigger>
              <SelectContent>{accounts.filter(a => a.is_active).map(a => <SelectItem key={a.id} value={a.id}>{a.account_name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">历史收款/付款流水未标注属于哪个账户，归集后即计入该账户日记账余额。</p>
          {loading ? <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> : (
            <>
              <div>
                <p className="text-sm font-medium mb-1 text-green-700">收款（{data.receipts.length}）</p>
                <div className="space-y-1 max-h-[180px] overflow-y-auto">
                  {data.receipts.length === 0 && <p className="text-xs text-muted-foreground">无</p>}
                  {data.receipts.map(r => (
                    <div key={r.id as string} className="flex items-center justify-between text-xs p-1.5 rounded border">
                      <span>{String(r.received_at || '').slice(0, 10)} · {String(r.customer_name || '—')} · {String(r.currency)} {Number(r.amount_original || 0).toLocaleString()}{r.bank_account ? ` · ${r.bank_account}` : ''}</span>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => assign('receipt', r.id as string)}>归入</Button>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-sm font-medium mb-1 text-red-700">付款（{data.payments.length}）</p>
                <div className="space-y-1 max-h-[180px] overflow-y-auto">
                  {data.payments.length === 0 && <p className="text-xs text-muted-foreground">无</p>}
                  {data.payments.map(p => (
                    <div key={p.id as string} className="flex items-center justify-between text-xs p-1.5 rounded border">
                      <span>{String(p.paid_at || '').slice(0, 10)} · {String(p.supplier_name || '—')} · {String(p.currency)} {Number(p.amount || 0).toLocaleString()}</span>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => assign('payment', p.id as string)}>归入</Button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── 内部转账 / 结汇 ─────────────────────────────
function TransferDialog({ open, onOpenChange, accounts, defaultFrom, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; accounts: JournalAccount[]; defaultFrom: string; onDone: () => void
}) {
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [date, setDate] = useState('')
  const [amtOut, setAmtOut] = useState('')
  const [amtIn, setAmtIn] = useState('')
  const [summary, setSummary] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) { setFromId(defaultFrom || ''); setToId(''); setDate(bizToday()); setAmtOut(''); setAmtIn(''); setSummary('') }
  }, [open, defaultFrom])

  const active = accounts.filter(a => a.is_active)
  const from = accounts.find(a => a.id === fromId) || null
  const to = accounts.find(a => a.id === toId) || null
  const cross = !!from && !!to && from.currency !== to.currency
  const nOut = Number(amtOut) || 0
  const nIn = cross ? (Number(amtIn) || 0) : nOut
  const rate = cross && nOut > 0 && nIn > 0 ? Math.round((nIn / nOut) * 10000) / 10000 : 0

  async function save() {
    if (!fromId || !toId) { toast.error('请选择转出/转入账户'); return }
    if (fromId === toId) { toast.error('转出与转入账户不能相同'); return }
    if (!(nOut > 0) || !(nIn > 0)) { toast.error('请输入有效金额'); return }
    if (!date) { toast.error('请选择日期'); return }
    setSaving(true)
    const { error } = await createTransfer({
      fromAccountId: fromId, toAccountId: toId, date,
      amountOut: nOut, currencyOut: from!.currency,
      amountIn: nIn, currencyIn: to!.currency,
      fromName: from!.account_name, toName: to!.account_name,
      summary: summary || null,
    })
    setSaving(false)
    if (error) { toast.error(`转账失败：${error}`); return }
    toast.success(cross ? '已记结汇（一出一进）' : '已记内部转账')
    onOpenChange(false); onDone()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>内部转账 / 结汇</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>转出账户</Label>
              <Select value={fromId} onValueChange={v => setFromId(v || '')}>
                <SelectTrigger><SelectValue placeholder="选择账户" /></SelectTrigger>
                <SelectContent>{active.map(a => <SelectItem key={a.id} value={a.id}>{a.account_name}（{a.currency}）</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>转入账户</Label>
              <Select value={toId} onValueChange={v => setToId(v || '')}>
                <SelectTrigger><SelectValue placeholder="选择账户" /></SelectTrigger>
                <SelectContent>{active.filter(a => a.id !== fromId).map(a => <SelectItem key={a.id} value={a.id}>{a.account_name}（{a.currency}）</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1"><Label>日期</Label><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>转出金额{from ? `（${from.currency}）` : ''}</Label><Input type="number" step="0.01" value={amtOut} onChange={e => setAmtOut(e.target.value)} placeholder="0.00" /></div>
            {cross
              ? <div className="space-y-1"><Label>转入金额（{to!.currency}）</Label><Input type="number" step="0.01" value={amtIn} onChange={e => setAmtIn(e.target.value)} placeholder="0.00" /></div>
              : <div className="space-y-1"><Label>转入金额</Label><Input disabled value={amtOut} placeholder="同币种等额" /></div>}
          </div>
          {cross && <p className="text-xs text-amber-600">结汇汇率：{rate || '—'}（= 转入 ÷ 转出，自动留痕到摘要）</p>}
          <div className="space-y-1"><Label>摘要（可选）</Label><Input value={summary} onChange={e => setSummary(e.target.value)} placeholder={cross ? '如：RAG CI-54 货款结汇' : '内部资金调拨'} /></div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}{cross ? '记结汇' : '记转账'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
