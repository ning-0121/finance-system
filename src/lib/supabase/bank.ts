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
  source: 'receivable' | 'supplier' | 'manual'  // 候选来源：客户回款 / 供应商付款 / 关联往来(手工记账)
  label: string      // 展示用：客户/供应商/往来户 + 金额
  sub?: string       // 次要标签：往来类别/摘要
  amount: number     // CNY
  date: string
}

const r2 = (n: number) => Math.round(n * 100) / 100
const d10 = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : '')

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

/** 已被银行流水认领的 matched_id 集合（避免同一笔回款/付款/往来被匹配到多条银行流水） */
async function getClaimedIds(matchedType: 'receivable_payment' | 'supplier_payment' | 'manual'): Promise<Set<string>> {
  const supabase = createClient()
  const { data, error } = await supabase.from('bank_transactions')
    .select('matched_id').eq('match_status', 'matched').eq('matched_type', matchedType).not('matched_id', 'is', null)
  if (error) { console.error('[bank] getClaimedIds:', error.message); return new Set() }
  return new Set((data || []).map(r => r.matched_id as string))
}

/** 取往来候选：某方向、未被银行流水认领的手工记账(bank_journal_manual)。收→direction=in；付→direction=out。 */
async function getManualCandidates(direction: 'in' | 'out'): Promise<MatchCandidate[]> {
  const supabase = createClient()
  const [{ data, error }, claimed] = await Promise.all([
    supabase.from('bank_journal_manual')
      .select('id, counterparty, category, summary, amount, txn_date').eq('direction', direction).is('deleted_at', null)
      .order('txn_date', { ascending: false }).limit(500),
    getClaimedIds('manual'),
  ])
  if (error) console.error('[bank] getManualCandidates:', error.message)
  return (data || []).filter(m => !claimed.has(m.id as string)).map(m => ({
    id: m.id as string, source: 'manual' as const,
    label: `${(m.counterparty as string) || (m.category as string) || '往来'} ¥${Number(m.amount).toLocaleString()}`,
    sub: (m.category as string) || (m.summary as string) || undefined,
    amount: Number(m.amount) || 0, date: d10(m.txn_date as string),
  }))
}

/**
 * 取对账候选（三来源）：
 *   收(in) → 客户回款(receivable_payments) + 关联往来(手工记账·收)
 *   付(out)→ 供应商付款(supplier_payments) + 关联往来(手工记账·付)
 * 已被其他银行流水认领的一律排除，防重复对账。
 */
export async function getMatchCandidates(direction: 'in' | 'out'): Promise<MatchCandidate[]> {
  const supabase = createClient()
  if (direction === 'in') {
    const [{ data, error }, claimed, manual] = await Promise.all([
      supabase.from('receivable_payments')
        .select('id, customer_name, amount_cny, received_at').is('voided_at', null)
        .order('received_at', { ascending: false }).limit(500),
      getClaimedIds('receivable_payment'),
      getManualCandidates('in'),
    ])
    if (error) console.error('[bank] getMatchCandidates(in):', error.message)
    const recv = (data || []).filter(r => !claimed.has(r.id as string))
      .map(r => ({ id: r.id as string, source: 'receivable' as const, label: `${r.customer_name || '回款'} ¥${Number(r.amount_cny).toLocaleString()}`, amount: Number(r.amount_cny) || 0, date: (r.received_at as string) || '' }))
    return [...recv, ...manual]
  }
  const [{ data, error }, claimed, manual] = await Promise.all([
    supabase.from('supplier_payments')
      .select('id, supplier_name, amount, paid_at').is('deleted_at', null)
      .order('paid_at', { ascending: false }).limit(500),
    getClaimedIds('supplier_payment'),
    getManualCandidates('out'),
  ])
  if (error) console.error('[bank] getMatchCandidates(out):', error.message)
  const pay = (data || []).filter(p => !claimed.has(p.id as string))
    .map(p => ({ id: p.id as string, source: 'supplier' as const, label: `${p.supplier_name || '付款'} ¥${Number(p.amount).toLocaleString()}`, amount: Number(p.amount) || 0, date: (p.paid_at as string) || '' }))
  return [...pay, ...manual]
}

/** 候选来源 → bank_transactions.matched_type */
export function candidateMatchedType(source: MatchCandidate['source']): 'receivable_payment' | 'supplier_payment' | 'manual' {
  return source === 'receivable' ? 'receivable_payment' : source === 'supplier' ? 'supplier_payment' : 'manual'
}

/**
 * 纯函数：为一条银行流水推荐最优匹配。
 * 金额必须相等（资金安全，不做近似），±7天内；同额多候选时按「对方户名相符」优先，再取日期最近。
 */
export function suggestMatch(txn: BankTxn, candidates: MatchCandidate[]): MatchCandidate | null {
  const txnTime = new Date(txn.txn_date).getTime()
  const cp = (txn.counterparty || '').trim()
  const sameAmount = candidates.filter(c => Math.abs(c.amount - txn.amount) < 0.01)
  if (sameAmount.length === 0) return null
  const within = sameAmount
    .map(c => {
      const name = (c.label.split(' ¥')[0] || '').trim()
      const nameHit = cp && name && (name.includes(cp) || cp.includes(name)) ? 1 : 0
      return { c, nameHit, days: Math.abs((new Date(c.date).getTime() - txnTime) / 86400000) }
    })
    .filter(x => x.days <= 7)
    .sort((a, b) => b.nameHit - a.nameHit || a.days - b.days)
  return within[0]?.c || null
}

// ── 余额校验（只读比对，警示不写库）──────────────────
export interface DayBreak {
  date: string       // 断链的日期
  net: number        // 当日净额（收-付）
  detail: string     // 展示用说明
}
/**
 * 纯函数：对账单逐日断链检测。
 * 逐日校验「上日余额 + 当日净额 = 当日余额」。同日多笔顺序不可靠（导入同批 created_at 相同），
 * 故按日聚合：只要上日任一余额候选 + 当日净额 能命中当日任一余额候选即视为衔接；全都对不上才报断链。
 * 报出的日期大概率是漏导/重导/错账，供财务追查；不自动改任何数据。
 */
export function checkStatementDays(txns: Pick<BankTxn, 'txn_date' | 'direction' | 'amount' | 'balance_after'>[]): DayBreak[] {
  // 按日聚合：净额（全部行）+ 余额候选（带余额的行）
  const days = new Map<string, { net: number; bals: number[] }>()
  for (const t of txns) {
    const d = days.get(t.txn_date) || { net: 0, bals: [] }
    d.net += t.direction === 'in' ? t.amount : -t.amount
    if (t.balance_after != null) d.bals.push(Number(t.balance_after))
    days.set(t.txn_date, d)
  }
  const dates = [...days.keys()].sort()
  const breaks: DayBreak[] = []
  let prevBals: number[] | null = null
  let pendingNet = 0   // 无余额列的日子净额先攒着，并入下一个有余额的日子一起衔接
  for (const date of dates) {
    const { net, bals } = days.get(date)!
    if (bals.length === 0) { pendingNet += net; continue }
    const expectNet = pendingNet + net
    if (prevBals && prevBals.length > 0) {
      const hit = prevBals.some(pb => bals.some(b => Math.abs(b - (pb + expectNet)) < 0.01))
      if (!hit) breaks.push({ date, net: r2(expectNet), detail: `累计净额 ${expectNet >= 0 ? '+' : ''}${r2(expectNet).toLocaleString()} 与对账单余额不衔接，疑漏导/重导/错账` })
    }
    prevBals = bals
    pendingNet = 0
  }
  return breaks
}

// ── 性质路由（只读建议，财务确认）──────────────────
export interface NatureGuess {
  category: string | null                                                   // 建议记账类别（BOOK_CATEGORIES 之一）
  kind: 'receivable' | 'supplier' | 'expense' | 'wanglai' | 'transfer' | null // 性质大类
  label: string | null                                                      // 展示用短标签
}
// 关键词 → 类别/性质（顺序即优先级，先命中先返回）
const NATURE_RULES: { re: RegExp; category: string | null; kind: NatureGuess['kind'] }[] = [
  { re: /手续费|服务费|账户管理费|工本费|回单费/, category: '银行手续费', kind: 'expense' },
  // 只认「结汇/购汇」等换汇动作 → 内部转账；单纯 USD/美金 是币种，不代表转账（货款收付才是主）
  { re: /结汇|购汇|换汇|汇兑/, category: '内部转账', kind: 'transfer' },
  { re: /工资|薪资|代发|劳务费/, category: '工资', kind: 'expense' },
  { re: /退税|增值税|所得税|印花税|个税|完税|税款|报税/, category: '税费', kind: 'expense' },
  { re: /利息/, category: '利息', kind: 'expense' },
  { re: /报销|垫付/, category: '老板垫付', kind: 'wanglai' },
  { re: /借支|备用金/, category: '备用金', kind: 'wanglai' },
  { re: /快递|运费|物流|顺丰|邮费/, category: '快递费', kind: 'expense' },
  { re: /取现|现金支取|柜台取|ATM/i, category: '取现', kind: 'transfer' },
  { re: /转账|调拨|内部|划转/, category: '内部转账', kind: 'transfer' },
]

/** 读对方户名+摘要，猜这笔流水的性质（纯建议；人可改）。 */
export function guessNature(txn: { direction: 'in' | 'out'; counterparty?: string | null; summary?: string | null }): NatureGuess {
  const text = `${txn.counterparty || ''} ${txn.summary || ''}`
  for (const r of NATURE_RULES) {
    if (r.re.test(text)) return { category: r.category, kind: r.kind, label: r.category }
  }
  // 货款类：按方向提示回款/付款（引导去①匹配，不给类别）
  if (txn.direction === 'out' && /货款|采购|供应商|辅料|面料|布料|拉链|付款/.test(text))
    return { category: null, kind: 'supplier', label: '供应商付款' }
  if (txn.direction === 'in' && /货款|收款|客户|订单|回款/.test(text))
    return { category: null, kind: 'receivable', label: '客户回款' }
  return { category: null, kind: null, label: null }
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

/**
 * 直接记账并对账：为某条银行流水现场建一条手工记账(bank_journal_manual)并对账关联。
 * 覆盖"无对应系统单据"的流水：费用 / 往来(垫付·借支·其他应收付) / 内部转账 / 其他收支。
 * 金额/日期/方向/币种全部取自银行流水本身（不由人改，防错），只让财务补：类别 + 对方/往来户 + 摘要。
 * 人工在 UI 触发，记真实 auth.uid()（created_by/matched_by）——符合铁律。
 */
export async function createManualAndMatch(
  txn: Pick<BankTxn, 'id' | 'bank_account_id' | 'txn_date' | 'direction' | 'amount' | 'currency' | 'summary' | 'reference'>,
  wl: { counterparty: string; category: string | null; summary: string | null },
): Promise<{ error: string | null }> {
  const supabase = createClient()
  const counterparty = wl.counterparty.trim()
  if (!counterparty && !wl.category) return { error: '请选择类别，或填写对方/往来户' }
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData?.user?.id || null
  const { data: ins, error: insErr } = await supabase.from('bank_journal_manual').insert({
    bank_account_id: txn.bank_account_id,
    txn_date: txn.txn_date,
    direction: txn.direction,
    amount: r2(txn.amount),
    currency: txn.currency || 'CNY',
    category: wl.category || null,
    counterparty: counterparty || null,
    summary: wl.summary?.trim() || txn.summary || null,
    reference: txn.reference || null,
    created_by: uid,
  }).select('id').single()
  if (insErr) return { error: insErr.message }
  const newId = ins?.id as string
  const note = ['做账', wl.category, counterparty].filter(Boolean).join('·')
  const { error: mErr } = await supabase.from('bank_transactions').update({
    match_status: 'matched', matched_type: 'manual', matched_id: newId,
    match_note: note,
    matched_by: uid, matched_at: new Date().toISOString(),
  }).eq('id', txn.id)
  if (mErr) return { error: `已记账，但对账关联失败：${mErr.message}` }
  return { error: null }
}

export async function ignoreBankTxn(txnId: string, note: string): Promise<{ error: string | null }> {
  const supabase = createClient()
  const { data: userData } = await supabase.auth.getUser()
  const { error } = await supabase.from('bank_transactions').update({
    match_status: 'ignored', match_note: note, matched_by: userData?.user?.id || null, matched_at: new Date().toISOString(),
  }).eq('id', txnId)
  return { error: error?.message || null }
}
