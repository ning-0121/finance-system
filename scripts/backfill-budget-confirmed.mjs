// 一次性:为存量【已审批(approved)】预算单补发 budget.confirmed 到节拍器。
// 默认 DRY-RUN(只列不发)。真发加 --send。
// 幂等:request_id 与 client.ts 同构确定性键,节拍器按 request_id 去重,重跑安全。
// 用法: node scripts/backfill-budget-confirmed.mjs            # dry-run
//        node scripts/backfill-budget-confirmed.mjs --send    # 真发
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const env = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim()
}
const SEND = process.argv.includes('--send')
const OM_URL = env.ORDER_METRONOME_URL
const API_KEY = env.INTEGRATION_API_KEY
const SECRET = env.INTEGRATION_WEBHOOK_SECRET
if (!OM_URL || !API_KEY || !SECRET) { console.error('缺 ORDER_METRONOME_URL/INTEGRATION_API_KEY/INTEGRATION_WEBHOOK_SECRET'); process.exit(1) }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const sig = (body) => createHmac('sha256', SECRET).update(body).digest('hex')
const detId = (event, parts) => `fin-${event}-${parts.map(p => String(p ?? '')).join('-')}`.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 120)

// 已审批 + 有 qimo_order_id(能挂到节拍器订单) + 未软删
const { data: rows, error } = await sb.from('budget_orders')
  .select('id, order_no, qimo_order_id, total_revenue, currency, estimated_margin, status, deleted_at')
  .eq('status', 'approved').not('qimo_order_id', 'is', null).is('deleted_at', null)
  .order('created_at', { ascending: true })
if (error) { console.error('查询失败:', error.message); process.exit(1) }

const noQimo = (await sb.from('budget_orders').select('id', { count: 'exact', head: true })
  .eq('status', 'approved').is('qimo_order_id', null).is('deleted_at', null)).count || 0

console.log(`目标节拍器: ${OM_URL}`)
console.log(`模式: ${SEND ? '🔴 真发' : '🟢 DRY-RUN(只列不发,加 --send 真发)'}`)
console.log(`可补发(approved + 有qimo_order_id): ${rows.length} 张`)
if (noQimo) console.log(`⚠ 另有 ${noQimo} 张 approved 单没有 qimo_order_id —— 无法挂到节拍器订单,不补发(多为手工/历史单)`)
console.log('─'.repeat(70))

let sent = 0, failed = 0
for (const o of rows) {
  const data = {
    qimo_order_id: o.qimo_order_id, order_no: o.order_no, internal_order_no: null,
    amount: Number(o.total_revenue) || 0, currency: o.currency || 'CNY',
    note: `[补发] 财务已确认预算(毛利率 ${o.estimated_margin ?? '-'}%)`,
    at: new Date().toISOString(), source_ref: null,
  }
  const requestId = detId('budget.confirmed', [o.qimo_order_id, data.amount, data.currency])
  if (!SEND) { console.log(`  ${o.order_no}  qimo=${String(o.qimo_order_id).slice(0, 8)}  ${data.currency} ${data.amount}  rid=${requestId.slice(0, 44)}`); continue }
  const payload = { event: 'budget.confirmed', timestamp: new Date().toISOString(), source: 'finance-system', request_id: requestId, data, signature: '' }
  payload.signature = sig(JSON.stringify(payload))
  const signedBody = JSON.stringify(payload)
  try {
    const res = await fetch(`${OM_URL}/api/integration/finance-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'x-webhook-signature': sig(signedBody), 'x-source': 'finance-system' },
      body: signedBody, signal: AbortSignal.timeout(15000),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok) { sent++; console.log(`  ✅ ${o.order_no}  ${j.dedup ? '(已存在,幂等跳过)' : '已记'}`) }
    else { failed++; console.log(`  ❌ ${o.order_no}  HTTP ${res.status} ${JSON.stringify(j).slice(0, 120)}`) }
  } catch (e) { failed++; console.log(`  ❌ ${o.order_no}  ${e.message}`) }
}
console.log('─'.repeat(70))
console.log(SEND ? `完成: 成功 ${sent}, 失败 ${failed}` : `DRY-RUN 完成: 共 ${rows.length} 张待补发。确认无误后加 --send 真发。`)
