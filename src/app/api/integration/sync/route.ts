// POST /api/integration/sync
// 从节拍器Supabase主动拉取最新订单，同步到财务系统
import { NextResponse } from 'next/server'
import { createClient as createMetronomeClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

const METRONOME_URL = process.env.METRONOME_SUPABASE_URL || ''
const METRONOME_KEY = process.env.METRONOME_SUPABASE_SERVICE_KEY || ''

export async function POST() {
  if (!METRONOME_URL || !METRONOME_KEY) {
    return NextResponse.json({ error: '节拍器Supabase未配置' }, { status: 500 })
  }

  try {
    const metronome = createMetronomeClient(METRONOME_URL, METRONOME_KEY)
    const finance = await createClient()

    // 1. 读取节拍器所有订单
    const { data: metronomeOrders, error: readErr } = await metronome
      .from('orders')
      .select('id, order_no, internal_order_no, customer_name, factory_name, quantity, quantity_unit, currency, total_amount, unit_price, incoterm, delivery_type, order_type, lifecycle_status, po_number, etd, payment_terms, notes, created_at, updated_at')
      .order('created_at', { ascending: false })

    if (readErr) throw new Error(`读取节拍器失败: ${readErr.message}`)
    if (!metronomeOrders?.length) {
      return NextResponse.json({ synced: 0, created: 0, message: '节拍器无订单' })
    }

    // 2. 读取已同步的订单
    const { data: existingSynced } = await finance
      .from('synced_orders')
      .select('id, order_no, style_no')

    const syncedMap = new Map<string, string>()
    existingSynced?.forEach(s => {
      if (s.order_no) syncedMap.set(s.order_no, s.id)
    })

    // 3. 找出未同步的
    const newOrders = metronomeOrders.filter(o => !syncedMap.has(o.order_no))

    if (newOrders.length === 0) {
      return NextResponse.json({ synced: 0, created: 0, total: metronomeOrders.length, message: '所有订单已同步' })
    }

    // 4. 批量写入synced_orders
    const syncedInserts = newOrders.map(o => ({
      id: o.id,
      order_no: o.order_no,
      customer_name: o.customer_name || '',
      style_no: o.internal_order_no || '',
      currency: o.currency || 'USD',
      quantity: o.quantity,
      quantity_unit: o.quantity_unit || '件',
      unit_price: o.unit_price,
      total_amount: o.total_amount,
      factory_name: o.factory_name,
      lifecycle_status: o.lifecycle_status || 'draft',
      incoterm: o.incoterm,
      delivery_type: o.delivery_type,
      order_type: o.order_type,
      po_number: o.po_number,
      etd: o.etd,
      payment_terms: o.payment_terms,
      notes: o.notes,
      source_created_at: o.created_at,
      source_updated_at: o.updated_at,
      synced_at: new Date().toISOString(),
    }))

    const { error: syncErr } = await finance
      .from('synced_orders')
      .upsert(syncedInserts, { onConflict: 'id' })

    if (syncErr) throw new Error(`写入synced_orders失败: ${syncErr.message}`)

    // 5. 为新订单创建budget_orders草稿
    let createdCount = 0
    for (const o of newOrders) {
      // 查找或创建客户
      let customerId: string | null = null
      if (o.customer_name) {
        const { data: existing } = await finance
          .from('customers')
          .select('id')
          .ilike('company', `%${o.customer_name}%`)
          .limit(1)

        if (existing?.length) {
          customerId = existing[0].id
        } else {
          const { data: newCust } = await finance
            .from('customers')
            .insert({ name: o.customer_name, company: o.customer_name, currency: o.currency || 'USD' })
            .select('id')
            .single()
          if (newCust) customerId = newCust.id
        }
      }

      // 查找已有budget_order（避免重复）
      const { data: existingBO } = await finance
        .from('budget_orders')
        .select('id')
        .ilike('notes', `%${o.order_no}%`)
        .limit(1)

      if (existingBO?.length) {
        // 已有，只需关联
        await finance.from('synced_orders').update({ budget_order_id: existingBO[0].id }).eq('id', o.id)
        continue
      }

      // 获取创建者profile
      const { data: profiles } = await finance.from('profiles').select('id').limit(1)
      const createdBy = profiles?.[0]?.id

      if (!createdBy || !customerId) continue

      const totalAmount = Number(o.total_amount) || (Number(o.unit_price || 0) * Number(o.quantity || 0))

      const { data: newBO } = await finance.from('budget_orders').insert({
        order_no: '',
        customer_id: customerId,
        total_revenue: totalAmount,
        currency: o.currency || 'USD',
        exchange_rate: 6.9,
        status: 'draft',
        order_date: new Date().toISOString().substring(0, 10),
        created_by: createdBy,
        notes: `来源: 订单节拍器 节拍器订单号: ${o.order_no} 内部单号: ${o.internal_order_no || ''} 客户: ${o.customer_name || ''} 数量: ${o.quantity || ''}${o.quantity_unit || '件'}`,
        has_sub_documents: false,
      }).select('id').single()

      if (newBO) {
        await finance.from('synced_orders').update({ budget_order_id: newBO.id }).eq('id', o.id)
        createdCount++
      }
    }

    return NextResponse.json({
      synced: newOrders.length,
      created: createdCount,
      total: metronomeOrders.length,
      newOrders: newOrders.map(o => ({ order_no: o.order_no, internal: o.internal_order_no, customer: o.customer_name })),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
