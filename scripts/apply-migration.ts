/**
 * 应用 migration 到 Supabase。
 *
 * 用法一（推荐 — 用 DB 直连）:
 *   export DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
 *   npx tsx scripts/apply-migration.ts migrations/20260513_gl_balance_and_dup_guards.sql
 *
 * 用法二（用 RPC — 需先在 Supabase Studio 跑 scripts/_bootstrap_exec_sql.sql 一次性创建 exec_sql RPC）:
 *   npx tsx scripts/apply-migration.ts migrations/20260513_gl_balance_and_dup_guards.sql --via-rpc
 */
import fs from 'fs'
import path from 'path'

async function viaPg(url: string, sql: string) {
  const { Client } = await import('pg').catch(() => {
    throw new Error('需要先安装: npm i -D pg @types/pg')
  })
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await c.connect()
  try {
    await c.query(sql)
    console.log('✓ DDL 已执行')
  } finally { await c.end() }
}

async function viaRpc(sql: string) {
  const { createClient } = await import('@supabase/supabase-js')
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data, error } = await svc.rpc('exec_sql' as never, { sql } as never)
  if (error) throw new Error('exec_sql RPC 调用失败（RPC 是否已部署？跑 scripts/_bootstrap_exec_sql.sql）: ' + error.message)
  // exec_sql 的 EXCEPTION 块会把 DDL 错误包装成 {ok:false, error, detail}
  const result = data as { ok: boolean; error?: string; detail?: string } | null
  if (!result || result.ok === false) {
    throw new Error(`DDL 执行失败 (sqlstate ${result?.detail || '?'}): ${result?.error || 'unknown'}`)
  }
  console.log('✓ DDL 通过 RPC 已执行 (ok:true)')
}

async function main() {
  const file = process.argv[2]
  const viaRpcFlag = process.argv.includes('--via-rpc')
  if (!file) { console.error('用法: tsx scripts/apply-migration.ts <sql文件> [--via-rpc]'); process.exit(2) }
  const sql = fs.readFileSync(path.resolve(file), 'utf-8')
  console.log(`📄 ${file} (${sql.length} 字符)`)

  if (viaRpcFlag) {
    await viaRpc(sql)
  } else {
    const url = process.env.DATABASE_URL
    if (!url) { console.error('缺少 DATABASE_URL；或用 --via-rpc'); process.exit(2) }
    await viaPg(url, sql)
  }

  console.log('🎉 完成 — 现在可以跑 npx tsx tests/e2e-complex-scenarios.test.ts')
}
main().catch(e => { console.error('✗', e.message); process.exit(1) })
