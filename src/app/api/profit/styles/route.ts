// ============================================================
// GET  /api/profit/styles?order_id=xxx  — list styles for an order
// POST /api/profit/styles               — create new style record
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { z } from 'zod'

const StyleSchema = z.object({
  budget_order_id: z.string().min(1),
  style_no: z.string().min(1),
  product_category: z.string().optional(),
  size_type: z.string().optional().default('missy'),
  qty: z.number().int().min(0).default(0),
  selling_price_per_piece_usd: z.number().min(0).default(0),
  fabric_usage_kg_per_piece: z.number().min(0).default(0),
  fabric_price_per_kg_rmb: z.number().min(0).default(0),
  cmt_cost_per_piece_rmb: z.number().min(0).default(0),
  trim_cost_per_piece_rmb: z.number().min(0).default(0),
  packing_cost_per_piece_rmb: z.number().min(0).default(0),
  freight_cost_per_piece_usd: z.number().min(0).default(0),
  other_cost_per_piece_rmb: z.number().min(0).default(0),
  exchange_rate: z.number().positive().default(7),
  notes: z.string().optional(),
})

export async function GET(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const orderId = request.nextUrl.searchParams.get('order_id')
  if (!orderId) return NextResponse.json({ error: '缺少 order_id' }, { status: 400 })

  try {
    const supabase = await createClient()
    const { data, error } = await supabase
      .from('profit_order_styles')
      .select('*')
      .eq('budget_order_id', orderId)
      .order('created_at')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ styles: data || [] })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  // Sales cannot create style records
  if (auth.role === 'sales') {
    return NextResponse.json({ error: '销售角色无权创建款式成本记录' }, { status: 403 })
  }

  try {
    const raw = await request.json()
    const parsed = StyleSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map(i => i.message).join('; ') }, { status: 400 })
    }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from('profit_order_styles')
      .insert(parsed.data)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ style: data }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
