// ============================================================
// 银行日记账（企业侧现金流水账）
// 数据源：自动汇入 回款流水(收) + 供应商付款流水(付)，叠加 手工补录(bank_journal_manual)。
// 逐笔余额 = 账户期初余额 + 累计(收-付)。金额口径按账户币种（默认 CNY）。
// 只读聚合 + 手工项/归集写入；不改动收付流水金额。
// ============================================================
import { createClient } from './client'

export interface JournalAccount {
  id: string
  account_name: string
  bank_name: string | null
  account_number: string | null
  currency: string
  account_type: 'bank' | 'alipay' | 'wechat' | 'cash' | null
  opening_balance: number
  opening_date: string | null
  is_active: boolean
  current_balance?: number   // 对账页余额徽标用（银行对账单最新余额）
}

export interface JournalRow {
  key: string
  source: 'manual' | 'receipt' | 'payment'
  sourceId: string
  date: string          // YYYY-MM-DD
  direction: 'in' | 'out'
  amount: number        // 账户币种口径（用于算余额）
  currency: string
  category: string | null
  counterparty: string | null
  summary: string | null
  reference: string | null
  balance: number       // 该笔后的逐笔余额
  editable: boolean     // 仅手工项可改/删
}

export interface JournalResult {
  opening: number
  openingDate: string | null
  rows: JournalRow[]    // 按日期升序 + 已带逐笔余额（已按 from/to 过滤显示，但余额是全量累计）
  totalIn: number       // 本期(显示范围)收入
  totalOut: number      // 本期(显示范围)支出
  closing: number       // 期末余额（显示范围最后一笔）
}

export const ACCOUNT_TYPE_LABEL: Record<string, string> = { bank: '银行', alipay: '支付宝', wechat: '微信', cash: '现金' }
export const MANUAL_CATEGORIES = ['银行手续费', '税费', '工资', '内部转账', '利息收入', '取现', '其他收入', '其他支出'] as const

const d10 = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : '')
const r2 = (n: number) => Math.round(n * 100) / 100

// ── 内部转账 / 结汇：一出一进配对 ─────────────────
/**
 * 建一对转账流水（同 transfer_group）：转出账户记 out、转入账户记 in。
 * 同币种=内部转账（两额相等）；异币种=结汇（记汇率，摘要留痕 如 USD 206,733.60 @ 6.7812 → RMB 1,401,901.89）。
 * 人工在 UI 触发，记真实 auth.uid()——符合铁律。两账户逐笔余额随之一致联动。
 */
export async function createTransfer(p: {
  fromAccountId: string; toAccountId: string; date: string
  amountOut: number; currencyOut: string
  amountIn: number; currencyIn: string
  fromName?: string | null; toName?: string | null
  summary?: string | null
}): Promise<{ error: string | null }> {
  const supabase = createClient()
  if (!p.fromAccountId || !p.toAccountId) return { error: '请选择转出/转入账户' }
  if (p.fromAccountId === p.toAccountId) return { error: '转出与转入账户不能相同' }
  if (!(p.amountOut > 0) || !(p.amountIn > 0)) return { error: '请输入有效的转出/转入金额' }
  const cross = p.currencyOut !== p.currencyIn
  const cat = cross ? '结汇' : '内部转账'
  const rate4 = Math.round((p.amountIn / p.amountOut) * 10000) / 10000  // 汇率留 4 位小数
  const rateNote = cross
    ? `结汇 ${p.currencyOut} ${p.amountOut.toLocaleString()} @ ${rate4} → ${p.currencyIn} ${p.amountIn.toLocaleString()}`
    : ''
  const summaryText = [p.summary?.trim(), rateNote].filter(Boolean).join(' · ') || (cross ? '结汇' : '内部转账')
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData?.user?.id || null
  const grp = crypto.randomUUID()
  const base = { transfer_group: grp, txn_date: p.date, category: cat, summary: summaryText, created_by: uid }
  const { error } = await supabase.from('bank_journal_manual').insert([
    { ...base, bank_account_id: p.fromAccountId, direction: 'out', amount: r2(p.amountOut), currency: p.currencyOut, counterparty: p.toName || null },
    { ...base, bank_account_id: p.toAccountId, direction: 'in', amount: r2(p.amountIn), currency: p.currencyIn, counterparty: p.fromName || null },
  ])
  return { error: error?.message || null }
}

// ── 账户档案 ─────────────────────────────
export async function getJournalAccounts(activeOnly = false): Promise<JournalAccount[]> {
  const supabase = createClient()
  let q = supabase.from('bank_accounts')
    .select('id, account_name, bank_name, account_number, currency, account_type, opening_balance, opening_date, is_active, current_balance')
    .order('is_active', { ascending: false }).order('account_name')
  if (activeOnly) q = q.eq('is_active', true)
  const { data, error } = await q
  if (error) { console.error('[bank-journal] getJournalAccounts:', error.message); return [] }
  return (data || []) as JournalAccount[]
}

export async function upsertAccount(a: Partial<JournalAccount> & { account_name: string }): Promise<{ error: string | null }> {
  const supabase = createClient()
  const row = {
    account_name: a.account_name.trim(),
    bank_name: a.bank_name?.trim() || null,
    account_number: a.account_number?.trim() || null,
    currency: a.currency || 'CNY',
    account_type: a.account_type || 'bank',
    opening_balance: Number(a.opening_balance) || 0,
    opening_date: a.opening_date || null,
    is_active: a.is_active ?? true,
  }
  const { error } = a.id
    ? await supabase.from('bank_accounts').update(row).eq('id', a.id)
    : await supabase.from('bank_accounts').insert(row)
  return { error: error?.message || null }
}

// ── 手工补录 ─────────────────────────────
export async function createManualEntry(e: {
  bank_account_id: string; txn_date: string; direction: 'in' | 'out'; amount: number
  currency?: string; category?: string | null; counterparty?: string | null; summary?: string | null; reference?: string | null
}): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { data: userData } = await supabase.auth.getUser()
  const { error } = await supabase.from('bank_journal_manual').insert({
    bank_account_id: e.bank_account_id, txn_date: e.txn_date, direction: e.direction,
    amount: Number(e.amount) || 0, currency: e.currency || 'CNY',
    category: e.category || null, counterparty: e.counterparty?.trim() || null,
    summary: e.summary?.trim() || null, reference: e.reference?.trim() || null,
    created_by: userData?.user?.id || null,
  })
  return { error: error?.message || null }
}

export async function updateManualEntry(id: string, e: {
  txn_date: string; direction: 'in' | 'out'; amount: number
  currency?: string; category?: string | null; counterparty?: string | null; summary?: string | null; reference?: string | null
}): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { error } = await supabase.from('bank_journal_manual').update({
    txn_date: e.txn_date, direction: e.direction, amount: Number(e.amount) || 0, currency: e.currency || 'CNY',
    category: e.category || null, counterparty: e.counterparty?.trim() || null,
    summary: e.summary?.trim() || null, reference: e.reference?.trim() || null, updated_at: new Date().toISOString(),
  }).eq('id', id)
  return { error: error?.message || null }
}

export async function deleteManualEntry(id: string): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { data: userData } = await supabase.auth.getUser()
  const { error } = await supabase.from('bank_journal_manual')
    .update({ deleted_at: new Date().toISOString(), deleted_by: userData?.user?.id || null, delete_reason: '手工删除' }).eq('id', id)
  return { error: error?.message || null }
}

// ── 归集：把未归集的收/付流水挂到某账户 ─────────
export async function getUnassigned(): Promise<{ receipts: Record<string, unknown>[]; payments: Record<string, unknown>[] }> {
  const supabase = createClient()
  const [{ data: r }, { data: p }] = await Promise.all([
    supabase.from('receivable_payments').select('id, customer_name, amount_original, amount_cny, currency, received_at, bank_account, payment_reference')
      .is('bank_account_id', null).is('voided_at', null).order('received_at', { ascending: false }).limit(500),
    supabase.from('supplier_payments').select('id, supplier_name, amount, currency, paid_at, note')
      .is('bank_account_id', null).is('deleted_at', null).order('paid_at', { ascending: false }).limit(500),
  ])
  return { receipts: r || [], payments: p || [] }
}

export async function assignAccount(source: 'receipt' | 'payment', id: string, accountId: string): Promise<{ error: string | null }> {
  const supabase = createClient()
  if (source === 'receipt') {
    // receivable_payments 收紧了 RLS（UPDATE 不开放）——普通 update 会 0 行且不报错(假成功)，
    // 必须走 SECURITY DEFINER RPC，否则收款归集丢失。
    const { error } = await supabase.rpc('assign_receipt_bank_account', { p_receipt_id: id, p_account_id: accountId })
    return { error: error?.message || null }
  }
  // supplier_payments 有 FOR UPDATE 策略：直接 update 后回读断言，避免 RLS 静默 0 行。
  const { data, error } = await supabase.from('supplier_payments')
    .update({ bank_account_id: accountId }).eq('id', id).select('id')
  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: '归集失败：未更新任何记录（可能无权限或记录不存在）' }
  return { error: null }
}

// ── 日记账主查询（某账户，逐笔余额） ─────────
export async function getJournal(accountId: string, from?: string, to?: string): Promise<JournalResult> {
  const supabase = createClient()
  const { data: acc } = await supabase.from('bank_accounts')
    .select('currency, opening_balance, opening_date').eq('id', accountId).maybeSingle()
  const accCurrency = (acc?.currency as string) || 'CNY'
  const opening = Number(acc?.opening_balance) || 0
  const openingDate = (acc?.opening_date as string) || null

  const [{ data: manual }, { data: receipts }, { data: payments }] = await Promise.all([
    supabase.from('bank_journal_manual').select('*').eq('bank_account_id', accountId).is('deleted_at', null),
    supabase.from('receivable_payments')
      .select('id, customer_name, amount_original, amount_cny, currency, received_at, payment_reference, notes')
      .eq('bank_account_id', accountId).is('voided_at', null),
    supabase.from('supplier_payments')
      .select('id, supplier_name, amount, currency, paid_at, note')
      .eq('bank_account_id', accountId).is('deleted_at', null),
  ])

  const rows: Omit<JournalRow, 'balance'>[] = []
  for (const m of manual || []) {
    rows.push({
      key: `m-${m.id}`, source: 'manual', sourceId: m.id as string, date: d10(m.txn_date as string),
      direction: m.direction as 'in' | 'out', amount: Number(m.amount) || 0, currency: (m.currency as string) || accCurrency,
      category: (m.category as string) || null, counterparty: (m.counterparty as string) || null,
      summary: (m.summary as string) || null, reference: (m.reference as string) || null, editable: true,
    })
  }
  for (const r of receipts || []) {
    // 收：账户币种一致取原币，否则取折人民币（账户为 CNY 的常见情形）
    const amt = (r.currency === accCurrency) ? (Number(r.amount_original) || 0) : (Number(r.amount_cny) || 0)
    rows.push({
      key: `r-${r.id}`, source: 'receipt', sourceId: r.id as string, date: d10(r.received_at as string),
      direction: 'in', amount: amt, currency: accCurrency, category: '客户回款',
      counterparty: (r.customer_name as string) || null, summary: '客户回款',
      reference: (r.payment_reference as string) || null, editable: false,
    })
  }
  for (const p of payments || []) {
    rows.push({
      key: `p-${p.id}`, source: 'payment', sourceId: p.id as string, date: d10(p.paid_at as string),
      direction: 'out', amount: Number(p.amount) || 0, currency: (p.currency as string) || accCurrency, category: '供应商付款',
      counterparty: (p.supplier_name as string) || null, summary: (p.note as string) || '供应商付款',
      reference: null, editable: false,
    })
  }

  // 全量按日期升序（同日按 source 稳定），算逐笔余额
  rows.sort((a, b) => a.date === b.date ? a.key.localeCompare(b.key) : a.date.localeCompare(b.date))
  let bal = opening
  const withBal: JournalRow[] = rows.map(r => {
    bal += r.direction === 'in' ? r.amount : -r.amount
    return { ...r, balance: Math.round(bal * 100) / 100 }
  })

  // 显示范围过滤（余额已是全量累计，过滤仅影响展示与本期合计）
  const inRange = withBal.filter(r => (!from || r.date >= from) && (!to || r.date <= to))
  const totalIn = Math.round(inRange.filter(r => r.direction === 'in').reduce((s, r) => s + r.amount, 0) * 100) / 100
  const totalOut = Math.round(inRange.filter(r => r.direction === 'out').reduce((s, r) => s + r.amount, 0) * 100) / 100
  const closing = withBal.length ? (inRange.length ? inRange[inRange.length - 1].balance : (from ? openingBefore(withBal, from) : opening)) : opening

  return { opening, openingDate, rows: inRange, totalIn, totalOut, closing }
}

// 范围起点之前的最后余额（用于范围内无数据时显示期末=期初区间余额）
function openingBefore(all: JournalRow[], from: string): number {
  let last = all[0]?.balance ?? 0
  for (const r of all) { if (r.date < from) last = r.balance; else break }
  return last
}
