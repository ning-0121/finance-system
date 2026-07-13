// 只对【draft】且 total_cost≠六桶和 的预算单,按桶和重算派生缓存 total_cost/estimated_profit/
// estimated_margin。不改任何业务金额(桶标量/收入/汇率/lines 全不动),只修被写脏的派生列。
// dry-run 默认;--apply 才写(乐观锁 version,只动 draft,防并发/防误改已审批单)。
// 用法: node scripts/recompute-draft-total-cost.mjs            # 预览
//        node scripts/recompute-draft-total-cost.mjs --apply    # 落库
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = {}; for (const l of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim() }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const APPLY = process.argv.includes('--apply')
const r2 = n => Math.round(n * 100) / 100
const KEYS = ['fabric', 'accessory', 'processing', 'forwarder', 'container', 'logistics']

let all = [], from = 0
for (;;) { const { data } = await sb.from('budget_orders').select('id,order_no,status,version,currency,exchange_rate,total_revenue,total_cost,estimated_profit,estimated_margin,items').eq('status', 'draft').is('deleted_at', null).range(from, from + 999); if (!data || !data.length) break; all = all.concat(data); if (data.length < 1000) break; from += 1000 }

const plan = []
for (const o of all) {
  const cb = o.items?.[0]?._cost_breakdown; if (!cb) continue
  const bucketSum = r2(KEYS.reduce((s, k) => s + (Number(cb[k]) || 0), 0))
  const extras = Array.isArray(cb.extras) ? cb.extras.reduce((s, e) => s + (Number(e?.amount) || 0), 0) : 0
  const newCost = r2(bucketSum + extras)
  if (Math.abs((Number(o.total_cost) || 0) - newCost) <= 0.01) continue
  const rate = o.currency === 'CNY' ? 1 : (Number(o.exchange_rate) > 0 ? Number(o.exchange_rate) : null)
  const revCny = rate != null ? r2((Number(o.total_revenue) || 0) * rate) : null
  const newProfit = revCny != null ? r2(revCny - newCost) : null
  const newMargin = newProfit != null && revCny ? r2((newProfit / revCny) * 100) : null
  plan.push({ o, newCost, newProfit, newMargin, rateMissing: rate == null })
}

console.log(`模式: ${APPLY ? '🔴 --apply 落库' : '🟢 DRY-RUN(预览,加 --apply 落库)'}`)
console.log(`待重算 draft 单: ${plan.length}`)
const missRate = plan.filter(p => p.rateMissing)
if (missRate.length) console.log(`⚠ 其中 ${missRate.length} 张外币缺汇率——只重算 total_cost,利润不算(需财务补汇率):${missRate.slice(0, 8).map(p => p.o.order_no).join('、')}`)
console.log('─'.repeat(72))
let done = 0, conflict = 0, err = 0
for (const p of plan) {
  const { o, newCost, newProfit, newMargin } = p
  if (!APPLY) { console.log(`  ${o.order_no}  total_cost ${o.total_cost}→${newCost}${newProfit != null ? `  profit→${newProfit} (${newMargin}%)` : '  (缺汇率,利润不动)'}`); continue }
  const patch = { total_cost: newCost }
  if (newProfit != null) { patch.estimated_profit = newProfit; patch.estimated_margin = newMargin }
  // 乐观锁:version 不变 + 仍是 draft 才写(防并发被审批/被改)
  const { data: hit, error } = await sb.from('budget_orders').update(patch).eq('id', o.id).eq('version', o.version).eq('status', 'draft').select('id')
  if (error) { err++; console.log(`  ❌ ${o.order_no} ${error.message}`) }
  else if (!hit || !hit.length) { conflict++; console.log(`  ⚠ ${o.order_no} 已被改动(version/status 变),跳过`) }
  else { done++; console.log(`  ✅ ${o.order_no} total_cost=${newCost}`) }
}
console.log('─'.repeat(72))
console.log(APPLY ? `完成: 重算 ${done}, 冲突跳过 ${conflict}, 失败 ${err}` : `DRY-RUN 完成: ${plan.length} 张待重算。确认后加 --apply。`)
