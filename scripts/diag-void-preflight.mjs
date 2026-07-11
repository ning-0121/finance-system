import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim()
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// 迷你版 normalizeOrderRefs
const normRefs = (raw) => Array.isArray(raw) ? raw.map(r => typeof r === 'object' && r ? { id: String(r.id||'').trim(), order_no: r.order_no||null } : { id: String(r).trim(), order_no: null }).filter(r=>r.id) : []

async function preflight(boId) {
  const items = []
  const add = (label, level, count, detail) => { if (count > 0) items.push({ label, level, count, detail }) }
  const { data: bo } = await sb.from('budget_orders').select('id, order_no, status').eq('id', boId).maybeSingle()
  if (!bo) return { orderNo: boId, err: 'not found' }
  const appr = ['approved','closed'].includes(bo.status)
  add('预算单', appr?'amber':'green', 1, `status=${bo.status}`)
  const { data: so } = await sb.from('synced_orders').select('id, order_no, style_no').eq('budget_order_id', boId)
  const sIds = new Set((so||[]).map(s=>s.id)), sNos = new Set((so||[]).map(s=>s.order_no).filter(Boolean))
  const { data: inv } = await sb.from('actual_invoices').select('status').eq('budget_order_id', boId).is('deleted_at', null)
  add('发票·待处理','green',(inv||[]).filter(r=>r.status==='pending').length,'')
  add('发票·已批准','amber',(inv||[]).filter(r=>['approved','disputed'].includes(r.status)).length,'')
  add('发票·已付款','red',(inv||[]).filter(r=>r.status==='paid').length,'')
  const { data: pay } = await sb.from('payable_records').select('payment_status, paid_at').eq('budget_order_id', boId).is('deleted_at', null)
  add('应付·未付','green',(pay||[]).filter(r=>r.payment_status==='unpaid').length,'')
  add('应付·已批准未付','amber',(pay||[]).filter(r=>['approved','pending_approval'].includes(r.payment_status)&&!r.paid_at).length,'')
  add('应付·已付款','red',(pay||[]).filter(r=>r.payment_status==='paid'||r.paid_at).length,'')
  const { data: st } = await sb.from('order_settlements').select('status').eq('budget_order_id', boId).is('deleted_at', null)
  add('决算·草稿','green',(st||[]).filter(r=>r.status==='draft').length,'')
  add('决算·已确认/锁定','amber',(st||[]).filter(r=>['confirmed','locked'].includes(r.status)).length,'')
  const { data: ci } = await sb.from('cost_items').select('id').eq('budget_order_id', boId).is('deleted_at', null)
  add('费用归集','green',(ci||[]).length,'')
  const { data: alloc } = await sb.from('receivable_payment_allocations').select('id').eq('budget_order_id', boId).is('voided_at', null)
  add('回款核销','red',(alloc||[]).length,'')
  if (sIds.size||sNos.size) {
    const { data: pos } = await sb.from('fin_purchase_orders').select('po_no, fin_status, order_refs').is('deleted_at', null)
    const mine = (pos||[]).filter(p => normRefs(p.order_refs).some(r => sIds.has(r.id)||(r.order_no&&sNos.has(r.order_no))))
    add('采购单·未决','green',mine.filter(p=>['pending','pending_approval'].includes(p.fin_status)).length,'')
    add('采购单·已批准(已下采购)','red',mine.filter(p=>p.fin_status==='approved').length,'')
  }
  if (sNos.size) {
    const { data: pa } = await sb.from('pending_approvals').select('id').eq('status','pending').in('order_no',[...sNos])
    add('集成审批·未决','green',(pa||[]).length,'')
  }
  const sev = items.some(i=>i.level==='red')?'🔴blocked_admin':items.some(i=>i.level==='amber')?'🟡has_approved':'🟢clean'
  return { orderNo: bo.order_no, status: bo.status, severity: sev, items }
}

// 取各状态代表订单验证
const { data: sample } = await sb.from('budget_orders').select('id, order_no, status').is('deleted_at', null).in('status',['draft','approved','closed']).limit(200)
const draft = (sample||[]).find(o=>o.status==='draft')
const approved = (sample||[]).find(o=>['approved','closed'].includes(o.status))
const targets = [
  '2321710e-766c-414b-855e-9c2d4017f607', // 年年旺 draft
  draft?.id, approved?.id,
].filter(Boolean)
for (const t of [...new Set(targets)]) {
  const r = await preflight(t)
  console.log(`\n━━ ${r.orderNo} [${r.status}] → ${r.severity}`)
  for (const it of r.items||[]) console.log(`   ${it.level==='red'?'🔴':it.level==='amber'?'🟡':'🟢'} ${it.label}: ${it.count}`)
}
process.exit(0)
