import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'
import { money, moneyString } from './money'

export const MAX_BANK_FILE_BYTES = 10 * 1024 * 1024
export const BANK_FILE_TYPES = ['xlsx', 'csv'] as const

const HEADER_ALIASES = {
  transactionDate: ['交易日期', '交易时间', 'transactiondate', 'date'],
  valueDate: ['记账日期', '起息日', 'valuedate'],
  debit: ['借方金额', '支出', 'debit'],
  credit: ['贷方金额', '收入', 'credit'],
  amount: ['金额', 'amount'],
  direction: ['收支方向', '方向', 'direction'],
  currency: ['币种', 'currency'],
  balance: ['余额', 'balance'],
  counterparty: ['对方户名', '交易对手', 'counterparty'],
  account: ['对方账号', 'counterpartyaccount'],
  reference: ['流水号', '交易流水号', 'reference'],
  memo: ['摘要', '用途', '附言', 'memo'],
} as const

type CanonicalHeader = keyof typeof HEADER_ALIASES

export interface ParsedBankRow {
  rowNumber: number
  transactionDate: string
  valueDate: string | null
  direction: 'credit' | 'debit'
  currency: string
  amount: string
  balance: string | null
  counterpartyName: string | null
  counterpartyAccountMasked: string | null
  reference: string | null
  memo: string | null
  fingerprint: string
}

function normalizedHeader(value: unknown) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s_\-/]+/g, '')
}

function mapHeaders(row: unknown[]): Map<CanonicalHeader, number> {
  const result = new Map<CanonicalHeader, number>()
  row.forEach((value, index) => {
    const header = normalizedHeader(value)
    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES) as [CanonicalHeader, readonly string[]][]) {
      if (aliases.some((alias) => normalizedHeader(alias) === header)) result.set(canonical, index)
    }
  })
  return result
}

function isoDate(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    return parsed ? `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}` : null
  }
  const text = String(value).trim().replace(/[./]/g, '-')
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  const us = text.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/)
  if (!us) return null
  const year = us[3].length === 2 ? `20${us[3]}` : us[3]
  return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
}

function text(value: unknown) { const result = String(value ?? '').trim(); return result || null }
function decimalInput(value: unknown): string | number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') return value.trim() || 0
  return 0
}
function maskAccount(value: unknown) {
  const raw = String(value ?? '').replace(/\s/g, '')
  if (!raw) return null
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-2)}`
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`
}

function parseCsv(source: string): unknown[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1 }
      else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(field); field = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(field); field = ''
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
    } else field += char
  }
  row.push(field)
  if (row.some((value) => value !== '')) rows.push(row)
  return rows
}

export function bankFileChecksum(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function bankTransactionFingerprint(input: Omit<ParsedBankRow, 'fingerprint' | 'rowNumber'> & { bankAccountId: string; externalTransactionId?: string | null }) {
  const parts = input.externalTransactionId
    ? [input.bankAccountId, input.externalTransactionId]
    : [input.bankAccountId, input.transactionDate, input.valueDate || '', input.direction, input.currency, input.amount,
      normalizedHeader(input.reference), normalizedHeader(input.counterpartyName)]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

export function parseBankStatement(bytes: Uint8Array, filename: string, bankAccountId: string) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BANK_FILE_BYTES) throw new Error('BANK_FILE_SIZE_INVALID')
  const extension = filename.split('.').pop()?.toLowerCase()
  if (!BANK_FILE_TYPES.includes(extension as (typeof BANK_FILE_TYPES)[number])) throw new Error('BANK_FILE_TYPE_UNSUPPORTED')
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) throw new Error('BANK_FILENAME_UNSAFE')
  let rows: unknown[][]
  if (extension === 'csv') {
    // Preserve date-only values exactly; spreadsheet coercion can shift them when
    // the server and statement timezones differ.
    rows = parseCsv(new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''))
  } else {
    const workbook = XLSX.read(bytes, { type: 'array', cellDates: false, dense: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!sheet) throw new Error('BANK_FILE_EMPTY')
    rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' })
  }
  if (!rows.length) throw new Error('BANK_FILE_EMPTY')
  const headers = mapHeaders(rows[0])
  if (!headers.has('transactionDate') || (!headers.has('amount') && !headers.has('credit') && !headers.has('debit'))) {
    throw new Error('BANK_REQUIRED_COLUMNS_MISSING')
  }
  const parsed: ParsedBankRow[] = []
  const errors: Array<{ rowNumber: number; code: string }> = []
  rows.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2
    const get = (key: CanonicalHeader) => headers.has(key) ? row[headers.get(key)!] : ''
    const transactionDate = isoDate(get('transactionDate'))
    const credit = money(decimalInput(get('credit')))
    const debit = money(decimalInput(get('debit')))
    const directionText = normalizedHeader(get('direction'))
    const direction: 'credit' | 'debit' = credit.gt(0) || /收|贷|credit|in/.test(directionText) ? 'credit' : 'debit'
    const amount = headers.has('amount') ? money(decimalInput(get('amount'))).abs() : (direction === 'credit' ? credit : debit).abs()
    if (!transactionDate || amount.lte(0)) { errors.push({ rowNumber, code: !transactionDate ? 'INVALID_DATE' : 'INVALID_AMOUNT' }); return }
    const base = {
      transactionDate,
      valueDate: isoDate(get('valueDate')),
      direction,
      currency: text(get('currency'))?.toUpperCase() || 'CNY',
      amount: moneyString(amount),
      balance: get('balance') === '' ? null : moneyString(get('balance') as string | number),
      counterpartyName: text(get('counterparty')),
      counterpartyAccountMasked: maskAccount(get('account')),
      reference: text(get('reference')),
      memo: text(get('memo')),
    }
    parsed.push({ rowNumber, ...base, fingerprint: bankTransactionFingerprint({ bankAccountId, ...base }) })
  })
  return { checksum: bankFileChecksum(bytes), rows: parsed, errors, sourceFilename: filename }
}
