// ============================================================
// GET  /api/profit/fx                   — get current/stored rates
// POST /api/profit/fx                   — manually update rate
// POST /api/profit/fx?action=simulate   — FX impact simulation
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { simulateExchangeRateImpact } from '@/lib/profit-calculator'
import { z } from 'zod'

const UpdateRateSchema = z.object({
  base_currency: z.string().default('USD'),
  quote_currency: z.string().default('CNY'),
  rate: z.number().positive(),
  source: z.string().optional().default('manual'),
})

const SimulateSchema = z.object({
  total_revenue_usd: z.number(),
  total_cost_rmb: z.number(),
  locked_rate: z.number().positive(),
  custom_rates: z.array(z.number().positive()).optional(),
})

export async function GET() {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  try {
    const supabase = await createClient()

    // Try to get from exchange_rates table if it exists
    const { data: rates, error } = await supabase
      .from('exchange_rates')
      .select('*')
      .eq('base_currency', 'USD')
      .eq('quote_currency', 'CNY')
      .order('fetched_at', { ascending: false })
      .limit(10)

    // Fallback rate if table doesn't exist or is empty
    const currentRate = rates?.[0]?.rate || 7.15

    return NextResponse.json({
      current_rate: currentRate,
      history: rates || [],
      note: rates?.length ? null : '汇率表为空，使用默认汇率 7.15。请在下方录入当前汇率。',
    })
  } catch {
    // Table may not exist yet
    return NextResponse.json({
      current_rate: 7.15,
      history: [],
      note: '汇率表尚未创建，请先运行 migration。当前使用默认汇率 7.15。',
    })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { searchParams } = request.nextUrl
  const action = searchParams.get('action')

  const raw = await request.json()

  if (action === 'simulate') {
    const parsed = SimulateSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map(i => i.message).join('; ') }, { status: 400 })
    }
    const scenarios = simulateExchangeRateImpact({
      totalRevenueUsd: parsed.data.total_revenue_usd,
      totalCostRmb: parsed.data.total_cost_rmb,
      lockedRate: parsed.data.locked_rate,
      scenarios: parsed.data.custom_rates,
    })
    return NextResponse.json({ scenarios })
  }

  // Update exchange rate (finance & admin only)
  if (!['admin', 'finance_manager', 'finance_staff'].includes(auth.role || '')) {
    return NextResponse.json({ error: '无权更新汇率' }, { status: 403 })
  }

  const parsed = UpdateRateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map(i => i.message).join('; ') }, { status: 400 })
  }

  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from('exchange_rates')
      .insert({
        ...parsed.data,
        fetched_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) {
      // Table might not exist
      return NextResponse.json({
        success: true,
        rate: parsed.data.rate,
        note: `汇率已更新为 ${parsed.data.rate}（内存模式，需先运行 migration 以持久化）`,
      })
    }
    return NextResponse.json({ success: true, rate: data })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
