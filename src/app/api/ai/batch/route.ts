// ============================================================
// POST /api/ai/batch  — 批量订单AI分析（Anthropic Batch API）
// GET  /api/ai/batch?id=batch_xxx — 查询进度 / 取结果
//
// 适用场景：月末批量生成所有订单的AI分析摘要
// 成本：比逐条调用便宜 50%，最长 24 小时完成
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' })

const BATCH_SYSTEM = `你是绮陌服饰的AI财务分析助手。
对于给出的单个订单数据，用中文生成简洁的财务分析摘要（200字以内），包含：
1. 利润健康度评估（优/良/警/差）
2. 最主要的风险点（1-2条）
3. 一条可操作的改进建议
格式：直接输出文字，不要 Markdown 标题。`

// ── POST：提交批量分析任务 ─────────────────────────────────
export async function POST(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('your_')) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY 未配置' }, { status: 400 })
  }

  try {
    const { order_ids } = await request.json() as { order_ids?: string[] }
    const supabase = await createClient()

    // 拉取要分析的订单
    let query = supabase
      .from('budget_orders')
      .select('id, order_no, total_revenue, total_cost, estimated_profit, estimated_margin, currency, status, customers(company, country)')
      .in('status', ['approved', 'closed'])

    if (order_ids?.length) {
      query = query.in('id', order_ids)
    } else {
      query = query.limit(100) // 默认分析最近100笔
    }

    const { data: orders, error: dbErr } = await query
    if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
    if (!orders?.length) return NextResponse.json({ error: '没有符合条件的订单' }, { status: 400 })

    // 构建 Batch 请求（每笔订单一个请求）
    const requests: Anthropic.Messages.MessageCreateParamsNonStreaming[] = orders.map(o => {
      const cust = (Array.isArray(o.customers) ? o.customers[0] : o.customers) as Record<string, unknown> | null
      const orderText = [
        `订单号: ${o.order_no}`,
        `客户: ${(cust?.company as string) || '未知'} (${(cust?.country as string) || ''})`,
        `币种: ${o.currency}`,
        `合同金额: ${o.total_revenue.toLocaleString()}`,
        `成本: ${o.total_cost.toLocaleString()}`,
        `利润: ${o.estimated_profit.toLocaleString()}`,
        `毛利率: ${o.estimated_margin}%`,
        `状态: ${o.status}`,
      ].join('\n')

      return {
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: BATCH_SYSTEM,
        messages: [{ role: 'user' as const, content: `请分析此订单：\n${orderText}` }],
      }
    })

    const batchRequests = orders.map((o, i) => ({
      custom_id: o.id,
      params: requests[i],
    }))

    const batch = await client.messages.batches.create({ requests: batchRequests })

    return NextResponse.json({
      batch_id: batch.id,
      status: batch.processing_status,
      total: orders.length,
      message: `已提交 ${orders.length} 笔订单的批量分析，批次ID: ${batch.id}`,
      // 预计完成时间：通常 < 1 小时，最长 24 小时
      estimated_completion: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `批量任务失败: ${msg}` }, { status: 500 })
  }
}

// ── GET：查询进度，完成后返回结果 ─────────────────────────
export async function GET(request: Request) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { searchParams } = new URL(request.url)
  const batchId = searchParams.get('id')
  if (!batchId) return NextResponse.json({ error: '缺少 batch id' }, { status: 400 })

  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('your_')) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY 未配置' }, { status: 400 })
  }

  try {
    const batch = await client.messages.batches.retrieve(batchId)

    if (batch.processing_status !== 'ended') {
      return NextResponse.json({
        batch_id: batchId,
        status: batch.processing_status,
        counts: batch.request_counts,
        message: batch.processing_status === 'in_progress'
          ? `处理中：${batch.request_counts.processing} 笔进行中，${batch.request_counts.succeeded} 笔完成`
          : '批次已取消',
      })
    }

    // 批次完成，收集所有结果
    const results: Record<string, string> = {}
    const errors: string[] = []

    for await (const result of await client.messages.batches.results(batchId)) {
      if (result.result.type === 'succeeded') {
        const textBlock = result.result.message.content.find(b => b.type === 'text')
        if (textBlock?.type === 'text') {
          results[result.custom_id] = textBlock.text
        }
      } else if (result.result.type === 'errored') {
        errors.push(`${result.custom_id}: ${result.result.error.type}`)
      }
    }

    return NextResponse.json({
      batch_id: batchId,
      status: 'ended',
      counts: batch.request_counts,
      results, // { order_id: "AI分析文字..." }
      errors,
      message: `完成：${batch.request_counts.succeeded} 成功，${batch.request_counts.errored} 失败`,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: `查询失败: ${msg}` }, { status: 500 })
  }
}
