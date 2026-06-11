// ============================================================
// 业务日期 — 一律按中国时区（Asia/Shanghai）取日
// 禁止用 new Date().toISOString().slice(0,10)：那是 UTC 日期，
// 北京时间 00:00–08:00 会取到前一天；部署在 Vercel(UTC) 的服务端
// 代码则全天受影响（录单日期、凭证日期、会计期间都会错位）。
// ============================================================

const CN_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })

/** 今天的业务日期（YYYY-MM-DD，中国时区） */
export function bizToday(): string {
  return CN_DATE.format(new Date())
}

/** 任意时间戳/ISO 串 → 中国时区的业务日期（YYYY-MM-DD）；无效输入返回 '' */
export function bizDateOf(value: string | number | Date | null | undefined): string {
  if (value == null || value === '') return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return CN_DATE.format(d)
}

/** 当前会计期间（YYYY-MM，中国时区） */
export function bizPeriod(): string {
  return bizToday().slice(0, 7)
}
