/**
 * 币种归一化(2026-08-08)
 *
 * 生产实证:节拍器订单币种传「RMB」,三条建预算单路径(手动建单/定时同步/webhook)
 * 都原样透传,而 budget_orders 的 chk_currency_valid 约束只认
 * USD/EUR/GBP/CNY/JPY/HKD —— 于是「建预算单失败: violates check constraint」,
 * 财务点按钮直接报错、单子建不进来。
 *
 * 全站读取侧早就两头兼容(`cur==='CNY'||cur==='RMB'`),唯独写入侧没人归一 ——
 * 又是「多条写入路径各写各的」这一类。归一化收敛到本函数,建单路径统一走它。
 */

/** budget_orders.chk_currency_valid 允许的币种(schema-security.sql:22) */
export const VALID_CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY', 'JPY', 'HKD'] as const
export type ValidCurrency = typeof VALID_CURRENCIES[number]

const ALIASES: Record<string, ValidCurrency> = {
  RMB: 'CNY', 'RMB¥': 'CNY', 人民币: 'CNY', 'CN¥': 'CNY',
  'US$': 'USD', USD$: 'USD', 美元: 'USD', 美金: 'USD',
  'HK$': 'HKD', 港币: 'HKD', 港元: 'HKD',
  欧元: 'EUR', 英镑: 'GBP', 日元: 'JPY', 'JP¥': 'JPY',
}

/**
 * 归一化到合法币种;认不出返回 null(调用方给出可读报错,不静默换成别的币)。
 * ⚠️ 不做"默认 USD"兜底 —— 把 AUD 单静默记成 USD 比报错更糟。
 */
export function normalizeCurrency(raw: unknown): ValidCurrency | null {
  const c = String(raw ?? '').trim().toUpperCase()
  if (!c) return null
  if ((VALID_CURRENCIES as readonly string[]).includes(c)) return c as ValidCurrency
  return ALIASES[c] ?? null
}

/** 建单路径专用:归一化,空值给默认,认不出抛可读错误(替代数据库约束的天书报错) */
export function currencyForBudget(raw: unknown, fallback: ValidCurrency): ValidCurrency {
  const c = String(raw ?? '').trim()
  if (!c) return fallback
  const n = normalizeCurrency(c)
  if (!n) throw new Error(`不支持的币种「${c}」——系统只支持 ${VALID_CURRENCIES.join('/')}(RMB 会自动记为 CNY)。请先在订单里改成合法币种。`)
  return n
}
