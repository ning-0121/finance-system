// ============================================================
// 银行流水与对账（Phase 2 #5）
// 导入对账单 → 与系统回款(receivable_payments)/付款(supplier_payments)逐笔对账。
// 收(in)→匹配回款；付(out)→匹配付款。幂等导入靠 dedup_key 唯一约束。
// ============================================================
import { createClient } from './client'
import { fetchAll } from './fetch-all'

export interface BankTxn {
  id: string
  bank_account_id: string
  txn_date: string
  direction: 'in' | 'out'
  amount: number
  currency: string
  balance_after: number | null
  counterparty: string | null
  summary: string | null
  reference: string | null
  match_status: 'unmatched' | 'matched' | 'ignored'
  matched_type: 'receivable_payment' | 'supplier_payment' | 'manual' | null
  matched_id: string | null
  match_note: string | null
}

export interface MatchCandidate {
  id: string
  label: string      // 展示用：客户/供应商 + 金额 + 日期
  amount: number     // CNY
  date: string
}

const r2 = (n: number) => Math.round(n * 100) / 100

/** 计算去重指纹（同一份对账单重复导入不产生重复行） */
export function computeDedupKey(row: { txn_date: string; direction: string; amount: number; counterparty?: string; summary?: string; reference?: string }): string {
  return [row.txn_date, row.direction, r2(row.amount), (row.counterparty || '').trim(), (row.summary || '').trim(), (row.reference || '').trim()].join('|')
}

export async function getBankAccounts() {
  const supabase = createClient()
  const { data, error } = await supabase.from('bank_accounts').select('id, account_name, bank_name, account_number, currency, current_balance, is_active').eq('is_active', true).order('account_name')
  if (error) console.error('[bank] getBankAccounts:', error.message)
  return data || []
}

export async function getBankTransactions(accountId: string): Promise<BankTxn[]> {
  const supabase = createClient()
  const { data, error } = await fetchAll<BankTxn>((f, t) => supabase.from('bank_transactions').select('*').eq('bank_account_id', accountId).order('txn_date', { ascending: false }).order('id', { ascending: true }).range(f, t))
  if (error) console.error('[bank] getBankTransactions:', error.message)
  return (data || []) as BankTxn[]
}

/** 批量导入流水（upsert + ignoreDuplicates 实现幂等） */
export async function importBankTransactions(
  accountId: string,
  rows: { txn_date: string; direction: 'in' | 'out'; amount: number; currency?: string; balance_after?: number | null; counterparty?: string; summary?: string; reference?: string }[],
  batch: string,
): Promise<{ inserted: number; skipped: number; error: string | null }> {
  const supabase = createClient()
  const { data: userData } = await supabase.auth.getUser()
  const payload = rows.map(r => ({
    bank_account_id: accountId,
    txn_date: r.txn_date,
    direction: r.direction,
    amount: r2(r.amount),
    currency: r.currency || 'CNY',
    balance_after: r.balance_after ?? null,
    counterparty: r.counterparty?.trim() || null,
    summary: r.summary?.trim() || null,
    reference: r.reference?.trim() || null,
    dedup_key: computeDedupKey(r),
    import_batch: batch,
    created_by: userData?.user?.id || null,
  }))
  // ignoreDuplicates：命中 (bank_account_id, dedup_key) 唯一约束的行被跳过
  const { data, error } = await supabase.from('bank_transactions')
    .upsert(payload, { onConflict: 'bank_account_id,dedup_key', ignoreDuplicates: true })
    .select('id')
  if (error) return { inserted: 0, skipped: 0, error: error.message }
  const inserted = data?.length || 0
  return { inserted, skipped: rows.length - inserted, error: null }
}

/** 用最新一条带余额的流水刷新账户余额（current_balance 上锚） */
export async function refreshAccountBalance(accountId: string): Promise<number | null> {
  const supabase = createClient()
  const { data } = await supabase.from('bank_transactions')
    .select('balance_after, txn_date').eq('bank_account_id', accountId).not('balance_after', 'is', null)
    .order('txn_date', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (data?.balance_after == null) return null
  const { error: updErr } = await supabase.from('bank_accounts').update({ current_balance: data.balance_after }).eq('id', accountId)
  if (updErr) { console.error('[bank] refreshAccountBalance update:', updErr.message); return null }  // 失败返回 null，调用方不显示"已更新"
  return Number(data.balance_after)
}

/** 已被银行流水认领的 matched_id 集合（避免同一笔回款/付款被匹配到多条银行流水） */
async function getClaimedIds(matchedType: 'receivable_payment' | 'supplier_payment'): Promise<Set<string>> {
  const supabase = createClient()
  const { data, error } = await supabase.from('bank_transactions')
    .select('matched_id').eq('match_status', 'matched').eq('matched_type', matchedType).not('matched_id', 'is', null)
  if (error) { console.error('[bank] getClaimedIds:', error.message); return new Set() }
  return new Set((data || []).map(r => r.matched_id as string))
}

/** 取对账候选：收→未被认领的回款流水；付→未被认领的供应商付款（已匹配过的排除，防重复对账） */
export async function getMatchCandidates(direction: 'in' | 'out'): Promise<MatchCandidate[]> {
  const supabase = createClient()
  if (direction === 'in') {
    const [{ data, error }, claimed] = await Promise.all([
      supabase.from('receivable_payments')
        .select('id, customer_name, amount_cny, received_at').is('voided_at', null)
        .order('received_at', { ascending: false }).limit(500),
      getClaimedIds('receivable_payment'),
    ])
    if (error) console.error('[bank] getMatchCandidates(in):', error.message)
    return (data || []).filter(r => !claimed.has(r.id as string))
      .map(r => ({ id: r.id as string, label: `${r.customer_name || '回款'} ¥${Number(r.amount_cny).toLocaleString()}`, amount: Number(r.amount_cny) || 0, date: (r.received_at as string) || '' }))
  }
  const [{ data, error }, claimed] = await Promise.all([
    supabase.from('supplier_payments')
      .select('id, supplier_name, amount, paid_at').is('deleted_at', null)
      .order('paid_at', { ascending: false }).limit(500),
    getClaimedIds('supplier_payment'),
  ])
  if (error) console.error('[bank] getMatchCandidates(out):', error.message)
  return (data || []).filter(p => !claimed.has(p.id as string))
    .map(p => ({ id: p.id as string, label: `${p.supplier_name || '付款'} ¥${Number(p.amount).toLocaleString()}`, amount: Number(p.amount) || 0, date: (p.paid_at as string) || '' }))
}

/** 纯函数：为一条银行流水推荐最优匹配（金额相等 + 日期最近，±7天内） */
export function suggestMatch(txn: BankTxn, candidates: MatchCandidate[]): MatchCandidate | null {
  const txnTime = new Date(txn.txn_date).getTime()
  const sameAmount = candidates.filter(c => Math.abs(c.amount - txn.amount) < 0.01)
  if (sameAmount.length === 0) return null
  const within = sameAmount
    .map(c => ({ c, days: Math.abs((new Date(c.date).getTime() - txnTime) / 86400000) }))
    .filter(x => x.days <= 7)
    .sort((a, b) => a.days - b.days)
  return within[0]?.c || null
}

export async function matchBankTxn(txnId: string, type: 'receivable_payment' | 'supplier_payment' | 'manual', targetId: string | null, note?: string): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { data: userData } = await supabase.auth.getUser()
  const { error } = await supabase.from('bank_transactions').update({
    match_status: 'matched', matched_type: type, matched_id: targetId,
    match_note: note || null, matched_by: userData?.user?.id || null, matched_at: new Date().toISOString(),
  }).eq('id', txnId)
  return { error: error?.message || null }
}

export async function unmatchBankTxn(txnId: string): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { error } = await supabase.from('bank_transactions').update({
    match_status: 'unmatched', matched_type: null, matched_id: null, match_note: null, matched_by: null, matched_at: null,
  }).eq('id', txnId)
  return { error: error?.message || null }
}

export async function ignoreBankTxn(txnId: string, note: string): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { data: userData } = await supabase.auth.getUser()
  const { error } = await supabase.from('bank_transactions').update({
    match_status: 'ignored', match_note: note, matched_by: userData?.user?.id || null, matched_at: new Date().toISOString(),
  }).eq('id', txnId)
  return { error: error?.message || null }
}
