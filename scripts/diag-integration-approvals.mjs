#!/usr/bin/env node
// 只读诊断:为什么「集成审批(来自节拍器)」是空的?看时间线。
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim()
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const p = (s) => console.log(s)
const d = (v) => (v ? String(v).slice(0, 19).replace('T', ' ') : '—')

// 1. pending_approvals 最近到达的 10 条(按 synced_at) + 状态/过期时间
{
  const { data } = await db.from('pending_approvals')
    .select('approval_type, status, order_no, synced_at, source_created_at, decided_at, decision_note')
    .order('synced_at', { ascending: false }).limit(10)
  p(`\n【pending_approvals 最近到达 10 条(按 synced_at)】`)
  for (const r of data || []) p(`  ${d(r.synced_at)} | ${r.approval_type}/${r.status} | ${r.order_no} | 决策@${d(r.decided_at)} | ${String(r.decision_note || '').slice(0, 30)}`)
  const { data: all } = await db.from('pending_approvals').select('synced_at, decided_at, status')
  const arr = all || []
  const syncs = arr.map(r => r.synced_at).filter(Boolean).sort()
  p(`\n  到达时间跨度: ${d(syncs[0])}  →  ${d(syncs[syncs.length - 1])}`)
  const decs = arr.filter(r => r.status === 'expired').map(r => r.decided_at).filter(Boolean).sort()
  p(`  过期(expired)决策时间跨度: ${d(decs[0])}  →  ${d(decs[decs.length - 1])}`)
}

// 2. fin_inbox_events:最近入站事件(received_at) + 审批类事件累计
{
  const { data, error } = await db.from('fin_inbox_events')
    .select('event, received_at, process_status').order('received_at', { ascending: false }).limit(3000)
  if (error) { p(`\n❌ fin_inbox_events: ${error.message}`) }
  else {
    p(`\n【fin_inbox_events】共取 ${data.length} 条,最近 8 条:`)
    for (const r of data.slice(0, 8)) p(`  ${d(r.received_at)} | ${r.event} | ${r.process_status}`)
    const by = {}
    for (const r of data) by[r.event] = (by[r.event] || 0) + 1
    p(`\n  按事件类型汇总:`)
    for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
      const isAppr = /approval|cancel\.requested|milestone\.requested|price_approval/.test(k)
      p(`   ${isAppr ? '👉' : '  '} ${k}: ${v}`)
    }
    const appr = data.filter(r => /approval|cancel\.requested|milestone\.requested|price_approval/.test(r.event))
    p(`\n  审批类入站事件累计: ${appr.length};最近一条: ${appr.length ? d(appr[0].received_at) + ' ' + appr[0].event : '无'}`)
  }
}
process.exit(0)
