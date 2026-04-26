// ============================================================
// POST /api/profit/import — CSV import for profit_order_styles
//
// CSV columns (header row required):
// order_no, style_no, product_category, size_type, qty,
// selling_price_per_piece_usd, fabric_usage_kg_per_piece,
// fabric_price_per_kg_rmb, cmt_cost_per_piece_rmb,
// trim_cost_per_piece_rmb, packing_cost_per_piece_rmb,
// freight_cost_per_piece_usd, exchange_rate
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/api-guard'

interface ParsedRow {
  order_no: string
  style_no: string
  product_category: string
  size_type: string
  qty: number
  selling_price_per_piece_usd: number
  fabric_usage_kg_per_piece: number
  fabric_price_per_kg_rmb: number
  cmt_cost_per_piece_rmb: number
  trim_cost_per_piece_rmb: number
  packing_cost_per_piece_rmb: number
  freight_cost_per_piece_usd: number
  exchange_rate: number
}

function parseCSV(text: string): { rows: ParsedRow[]; errors: string[] } {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length < 2) return { rows: [], errors: ['CSV 至少需要表头行和一行数据'] }

  const errors: string[] = []
  const rows: ParsedRow[] = []

  // Parse header
  const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''))

  const required = ['order_no', 'style_no']
  for (const req of required) {
    if (!header.includes(req)) {
      errors.push(`缺少必需列: ${req}`)
    }
  }
  if (errors.length) return { rows: [], errors }

  const idx = (col: string) => header.indexOf(col)

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''))
    const orderNo = cols[idx('order_no')] || ''
    const styleNo = cols[idx('style_no')] || ''

    if (!orderNo || !styleNo) {
      errors.push(`第 ${i + 1} 行: order_no 或 style_no 为空，已跳过`)
      continue
    }

    const num = (col: string, def = 0) => {
      const v = parseFloat(cols[idx(col)] || '')
      return isNaN(v) ? def : v
    }
    const str = (col: string, def = '') => cols[idx(col)] || def

    rows.push({
      order_no: orderNo,
      style_no: styleNo,
      product_category: str('product_category', 'other'),
      size_type: str('size_type', 'missy'),
      qty: Math.round(num('qty', 0)),
      selling_price_per_piece_usd: num('selling_price_per_piece_usd'),
      fabric_usage_kg_per_piece: num('fabric_usage_kg_per_piece'),
      fabric_price_per_kg_rmb: num('fabric_price_per_kg_rmb'),
      cmt_cost_per_piece_rmb: num('cmt_cost_per_piece_rmb'),
      trim_cost_per_piece_rmb: num('trim_cost_per_piece_rmb'),
      packing_cost_per_piece_rmb: num('packing_cost_per_piece_rmb'),
      freight_cost_per_piece_usd: num('freight_cost_per_piece_usd'),
      exchange_rate: num('exchange_rate', 7) || 7,
    })
  }

  return { rows, errors }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  if (!['admin', 'finance_manager', 'finance_staff'].includes(auth.role || '')) {
    return NextResponse.json({ error: '无权导入数据' }, { status: 403 })
  }

  try {
    const contentType = request.headers.get('content-type') || ''
    let csvText = ''

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const file = formData.get('file') as File | null
      if (!file) return NextResponse.json({ error: '请上传 CSV 文件' }, { status: 400 })
      csvText = await file.text()
    } else {
      const body = await request.json()
      csvText = body.csv || ''
    }

    if (!csvText) return NextResponse.json({ error: 'CSV 内容为空' }, { status: 400 })

    const { rows, errors } = parseCSV(csvText)
    if (rows.length === 0) {
      return NextResponse.json({ error: '没有可导入的数据行', parse_errors: errors }, { status: 400 })
    }

    const supabase = await createClient()

    // Resolve order_no → budget_order_id
    const orderNos = [...new Set(rows.map(r => r.order_no))]
    const { data: orders } = await supabase
      .from('budget_orders')
      .select('id, order_no, exchange_rate')
      .in('order_no', orderNos)

    const orderMap = new Map((orders || []).map(o => [o.order_no, o]))

    const toInsert = []
    const skipped: string[] = []

    for (const row of rows) {
      const order = orderMap.get(row.order_no)
      if (!order) {
        skipped.push(`订单号 ${row.order_no} 不存在，已跳过款式 ${row.style_no}`)
        continue
      }
      toInsert.push({
        budget_order_id: order.id,
        style_no: row.style_no,
        product_category: row.product_category,
        size_type: row.size_type,
        qty: row.qty,
        selling_price_per_piece_usd: row.selling_price_per_piece_usd,
        fabric_usage_kg_per_piece: row.fabric_usage_kg_per_piece,
        fabric_price_per_kg_rmb: row.fabric_price_per_kg_rmb,
        cmt_cost_per_piece_rmb: row.cmt_cost_per_piece_rmb,
        trim_cost_per_piece_rmb: row.trim_cost_per_piece_rmb,
        packing_cost_per_piece_rmb: row.packing_cost_per_piece_rmb,
        freight_cost_per_piece_usd: row.freight_cost_per_piece_usd,
        exchange_rate: row.exchange_rate || order.exchange_rate || 7,
      })
    }

    if (toInsert.length === 0) {
      return NextResponse.json({ error: '所有行均无法匹配订单', skipped }, { status: 400 })
    }

    // Upsert (same order + style_no = update)
    const { data: inserted, error: insertErr } = await supabase
      .from('profit_order_styles')
      .upsert(toInsert, { onConflict: 'budget_order_id,style_no' })
      .select('id')

    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 })

    return NextResponse.json({
      success: true,
      imported: inserted?.length || toInsert.length,
      skipped_count: skipped.length,
      parse_errors: errors,
      skipped_rows: skipped,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Import failed' }, { status: 500 })
  }
}
