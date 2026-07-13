// 只读:列 total_cost 与 _cost_breakdown 六桶和不符的预算单(审计116单¥993万),供财务UI核对修正。
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env={}; for (const l of readFileSync(new URL('../.env.local', import.meta.url),'utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim()}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const r2=n=>Math.round(n*100)/100
const KEYS=['fabric','accessory','processing','forwarder','container','logistics']
let all=[], from=0
for(;;){ const {data}=await sb.from('budget_orders').select('id,order_no,status,total_cost,estimated_profit,items,notes').is('deleted_at',null).range(from,from+999); if(!data||!data.length)break; all=all.concat(data); if(data.length<1000)break; from+=1000 }
const rows=[]
for(const o of all){
  const cb=o.items?.[0]?._cost_breakdown; if(!cb)continue
  const bucketSum=r2(KEYS.reduce((s,k)=>s+(Number(cb[k])||0),0))
  const extras=Array.isArray(cb.extras)?cb.extras.reduce((s,e)=>s+(Number(e?.amount)||0),0):0
  const recomputed=r2(bucketSum+extras)
  const diff=r2((Number(o.total_cost)||0)-recomputed)
  if(Math.abs(diff)>0.01) rows.push({order_no:o.order_no,status:o.status,total_cost_列:Number(o.total_cost)||0,桶和_重算:recomputed,差额:diff,source:(cb._source||(o.notes||'').slice(0,20))})
}
rows.sort((a,b)=>Math.abs(b.差额)-Math.abs(a.差额))
const byStatus={}; let tot=0
for(const r of rows){ byStatus[r.status]=(byStatus[r.status]||0)+1; tot=r2(tot+Math.abs(r.差额)) }
const head='订单号,状态,total_cost列,桶和重算,差额,来源'
const csv=[head,...rows.map(r=>[r.order_no,r.status,r.total_cost_列,r.桶和_重算,r.差额,`"${r.source}"`].join(','))].join('\n')
const { writeFileSync, mkdirSync }=await import('node:fs')
mkdirSync(new URL('../exports/',import.meta.url),{recursive:true})
writeFileSync(new URL('../exports/budget_total_cost_diff.csv',import.meta.url),'﻿'+csv)
console.log('不符单数:',rows.length,' 差额绝对值合计: ¥'+tot.toLocaleString())
console.log('按状态:',JSON.stringify(byStatus))
console.log('最差5单:'); rows.slice(0,5).forEach(r=>console.log(`  ${r.order_no} [${r.status}] 列${r.total_cost_列} vs 桶和${r.桶和_重算} 差${r.差额}`))
console.log('→ exports/budget_total_cost_diff.csv')
