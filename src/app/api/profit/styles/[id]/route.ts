// ============================================================
// PUT    /api/profit/styles/[id] — update style cost record
// DELETE /api/profit/styles/[id] — delete style record
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { z } from 'zod'

const UpdateSchema = z.object({
  style_no: z.string().min(1).optional(),
  product_category: z.string().optional(),
  size_type: z.string().optional(),
  qty: z.number().int().min(0).optional(),
  selling_price_per_piece_usd: z.number().min(0).optional(),
  fabric_usage_kg_per_piece: z.number().min(0).optional(),
  fabric_price_per_kg_rmb: z.number().min(0).optional(),
  cmt_cost_per_piece_rmb: z.number().min(0).optional(),
  trim_cost_per_piece_rmb: z.number().min(0).optional(),
  packing_cost_per_piece_rmb: z.number().min(0).optional(),
  freight_cost_per_piece_usd: z.number().min(0).optional(),
  other_cost_per_piece_rmb: z.number().min(0).optional(),
  exchange_rate: z.number().positive().optional(),
  notes: z.string().optional(),
})

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  if (auth.role === 'sales') {
    return NextResponse.json({ error: '销售角色无权修改款式成本' }, { status: 403 })
  }

  const { id } = await params

  try {
    const raw = await request.json()
    const parsed = UpdateSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues.map(i => i.message).join('; ') }, { status: 400 })
    }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from('profit_order_styles')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ style: data })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  if (!['admin', 'finance_manager'].includes(auth.role || '')) {
    return NextResponse.json({ error: '仅财务总监和管理员可删除款式记录' }, { status: 403 })
  }

  const { id } = await params

  try {
    const supabase = await createClient()
    const { error } = await supabase.from('profit_order_styles').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Server error' }, { status: 500 })
  }
}
