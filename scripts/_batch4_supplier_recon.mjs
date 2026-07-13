// 只读:D1并轨后(应付=cost_items,已付=supplier_payments)供应商对账异常清单,供财务核对。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env={}; for (const l of readFileSync(new URL('../.env.local', import.meta.url),'utf8').split('\n')){const m=l.match(/^([A-Z_]+)=(.*)$/);if(m)env[m[1]]=m[2].trim()}
const sb=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const r2=n=>Math.round(n*100)/100
const norm=s=>String(s||'').replace(/[（(].*?[)）]|\s/g,'').toLowerCase()
const cny=(amt,cur,rate)=> (cur==='CNY'?1:(Number(rate)||1))*(Number(amt)||0)
async function all(t,cols,f){let out=[],from=0;for(;;){let q=sb.from(t).select(cols).is('deleted_at',null).range(from,from+999);if(f)q=f(q);const{data}=await q;if(!data||!data.length)break;out=out.concat(data);if(data.length<1000)break;from+=1000}return out}
const ci=await all('cost_items','supplier,amount,currency,exchange_rate,cost_type,description,budget_order_id,source_module,id')
const sp=await all('supplier_payments','supplier_name,amount,currency,exchange_rate,id')
// 按供应商聚合
const bySup={}
for(const c of ci){ const k=norm(c.supplier)||'(未指定)'; (bySup[k]=bySup[k]||{name:c.supplier||'(未指定)',payable:0,paid:0,negRows:[]}); bySup[k].payable=r2(bySup[k].payable+cny(c.amount,c.currency,c.exchange_rate)); if(Number(c.amount)<0) bySup[k].negRows.push(`${c.description}:${c.amount}`) }
for(const p of sp){ const k=norm(p.supplier_name)||'(未指定)'; (bySup[k]=bySup[k]||{name:p.supplier_name||'(未指定)',payable:0,paid:0,negRows:[]}); bySup[k].paid=r2(bySup[k].paid+cny(p.amount,p.currency,p.exchange_rate)) }
const rows=Object.values(bySup).map(s=>({...s,balance:r2(s.payable-s.paid)})).sort((a,b)=>a.balance-b.balance)
// 异常:余额<0(超付/负成本) 或 有负成本行
const neg=rows.filter(s=>s.balance< -0.01 || s.negRows.length)
mkdirSync(new URL('../exports/',import.meta.url),{recursive:true})
const head='供应商,应付(cost_items¥),已付(supplier_payments¥),余额¥,负成本行'
writeFileSync(new URL('../exports/supplier_balance_anomaly.csv',import.meta.url),'﻿'+[head,...neg.map(s=>[`"${s.name}"`,s.payable,s.paid,s.balance,`"${s.negRows.join(' | ')}"`].join(','))].join('\n'))
// payable_records paid>amount
const pr=await all('payable_records','bill_no,supplier_name,amount,paid_amount,payment_status,id')
const over=pr.filter(p=>(Number(p.paid_amount)||0)>(Number(p.amount)||0)+0.01)
console.log('供应商总数:',rows.length,' 异常(负余额/负成本行):',neg.length)
console.log('负余额/负成本 前8:'); neg.slice(0,8).forEach(s=>console.log(`  ${s.name}  应付${s.payable} 已付${s.paid} 余额${s.balance}${s.negRows.length?'  负成本:'+s.negRows.join(';'):''}`))
console.log('payable_records 超付(paid>amount):',over.length, over.slice(0,5).map(p=>p.bill_no+':'+p.paid_amount+'>'+p.amount))
console.log('→ exports/supplier_balance_anomaly.csv')
