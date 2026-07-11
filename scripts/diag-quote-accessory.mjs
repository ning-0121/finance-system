import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) { const m=line.match(/^([A-Z_]+)=(.*)$/); if(m) env[m[1]]=m[2].trim() }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// 1022963 的同步单 + 冻结报价 payload + 预算 _cost_breakdown
const { data: so } = await sb.from('synced_orders')
  .select('id, order_no, style_no, quantity, budget_order_id, quotation_data')
  .or('style_no.eq.1022963,order_no.eq.QM-20260710-001').limit(3)
for (const s of so || []) {
  console.log(`━━ synced ${s.order_no} 内部=${s.style_no} qty=${s.quantity} budget=${s.budget_order_id}`)
  const qd = s.quotation_data
  if (qd) {
    console.log('  quotation_data keys:', Object.keys(qd).join(', '))
    if (qd.unit_costs) console.log('  unit_costs:', JSON.stringify(qd.unit_costs))
    if (qd.cost_lines) console.log('  cost_lines:', JSON.stringify(qd.cost_lines).slice(0, 1200))
    if (qd.cost_buckets) console.log('  cost_buckets:', JSON.stringify(qd.cost_buckets))
  } else console.log('  (无 quotation_data)')
  if (s.budget_order_id) {
    const { data: bo } = await sb.from('budget_orders').select('order_no, status, total_revenue, currency, items').eq('id', s.budget_order_id).maybeSingle()
    const cb = bo?.items?.[0]?._cost_breakdown
    console.log(`  budget ${bo?.order_no} status=${bo?.status} rev=${bo?.total_revenue}${bo?.currency}`)
    if (cb) {
      console.log('  桶标量:', JSON.stringify({fabric: cb.fabric, accessory: cb.accessory, processing: cb.processing, forwarder: cb.forwarder, container: cb.container, logistics: cb.logistics}))
      for (const [b, arr] of Object.entries(cb.lines || {})) console.log(`  lines.${b}:`, JSON.stringify(arr).slice(0, 600))
    }
  }
}
