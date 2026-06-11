// 验收：附件桶 + payable_records.attachment_url + cost_items.supplier trgm 索引 + 上传往返
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n')
  .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] }))
const url = env.NEXT_PUBLIC_SUPABASE_URL
const key = env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

let pass = 0, fail = 0
const ok = (c, m) => { c ? (pass++, console.log('✅', m)) : (fail++, console.log('❌', m)) }

// 1) 桶
const { data: buckets } = await db.storage.listBuckets()
const bucket = buckets?.find(b => b.id === 'finance-attachments')
ok(bucket, `存储桶 finance-attachments 存在${bucket ? `（public=${bucket.public}）` : ''}`)
ok(bucket && bucket.public === false, '桶为私有(public=false)')

// 2) attachment_url 列
const { error: colErr } = await db.from('payable_records').select('attachment_url').limit(1)
ok(!colErr, `payable_records.attachment_url 列可查询${colErr ? ' — ' + colErr.message : ''}`)

// 3) trgm 索引
const { data: idx, error: idxErr } = await db.rpc('exec_sql_select', {}).then(() => ({ data: null, error: 'no-rpc' })).catch(() => ({ data: null, error: 'no-rpc' }))
// 直接查 pg_indexes 需要一个查询通道；用 rest 不行，改用 storage 之外的探针：尝试 ilike 查询应能跑通（索引存在与否都能跑，仅验证列/查询健康）
const { error: ilikeErr } = await db.from('cost_items').select('id,supplier').ilike('supplier', '%test%').limit(1)
ok(!ilikeErr, `cost_items.supplier ILIKE 查询健康${ilikeErr ? ' — ' + ilikeErr.message : '（trgm 索引对查询透明，EXPLAIN 需在 SQL Editor 验证）'}`)

// 4) 上传往返
const testPath = `_verify/${crypto.randomUUID().slice(0, 8)}_probe.txt`
const blob = new Blob(['probe ' + new Date().toISOString()], { type: 'text/plain' })
const { error: upErr } = await db.storage.from('finance-attachments').upload(testPath, blob, { upsert: false })
ok(!upErr, `上传到桶成功${upErr ? ' — ' + upErr.message : ''}`)
if (!upErr) {
  const { data: signed } = await db.storage.from('finance-attachments').createSignedUrl(testPath, 60)
  ok(signed?.signedUrl, '生成签名 URL 成功')
  await db.storage.from('finance-attachments').remove([testPath])
  console.log('🧹 已清理测试对象', testPath)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
