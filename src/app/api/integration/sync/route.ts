// POST /api/integration/sync
// 从节拍器Supabase主动拉取最新订单，同步到财务系统
import { bizToday } from '@/lib/biz-date'
import { NextResponse } from 'next/server'
import { createClient as createMetronomeClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyApiKey } from '@/lib/integration/security'

const METRONOME_URL = process.env.METRONOME_SUPABASE_URL || ''
const METRONOME_KEY = process.env.METRONOME_SUPABASE_SERVICE_KEY || ''

export async function POST(request: Request) {
  if (!METRONOME_URL || !METRONOME_KEY) {
    return NextResponse.json({ error: '节拍器Supabase未配置' }, { status: 500 })
  }

  // 鉴权门：UI 按钮走登录会话；机器调用走 x-api-key（与 webhook 同一密钥）。
  // 此前无鉴权 + 会话客户端写库：匿名触发会被 RLS 拒(报错)，且任何人可打这个端点。
  const session = await createClient()
  const { data: sessionUser } = await session.auth.getUser()
  const apiKey = request.headers.get('x-api-key')
  const keyOk = !!apiKey && verifyApiKey(apiKey)
  if (!keyOk && !sessionUser?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const metronome = createMetronomeClient(METRONOME_URL, METRONOME_KEY)
    // 写库用 service 客户端（集成路由标准形态，与 webhook 一致）——
    // synced_orders/budget_orders 的 RLS 写策略要求财务角色会话，服务端同步不应受其约束
    const finance = createServiceClient()

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

    // 3. 找出未同步的新订单
    const newOrders = metronomeOrders.filter(o => !syncedMap.has(o.order_no))

    // 4. 更新已有订单的状态（逐条update避免唯一约束冲突）
    let updatedCount = 0
    for (const o of metronomeOrders) {
      if (syncedMap.has(o.order_no)) {
        // 已存在：更新lifecycle_status和style_no
        await finance.from('synced_orders').update({
          style_no: o.internal_order_no || '',
          lifecycle_status: o.lifecycle_status || 'draft',
          customer_name: o.customer_name || '',
          quantity: o.quantity,
          synced_at: new Date().toISOString(),
        }).eq('order_no', o.order_no)
        updatedCount++
      }
    }

    // 5. 写入新订单
    if (newOrders.length > 0) {
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

      // upsert 替代 insert：并发调用时按主键 id 去重，避免 TOCTOU 重复键错误
      const { error: syncErr } = await finance
        .from('synced_orders')
        .upsert(syncedInserts, { onConflict: 'id', ignoreDuplicates: false })

      if (syncErr) throw new Error(`写入synced_orders失败: ${syncErr.message}`)
    }

    if (newOrders.length === 0) {
      return NextResponse.json({ synced: 0, created: 0, updated: updatedCount, total: metronomeOrders.length, message: `已更新${updatedCount}个订单状态` })
    }

    // 5. 为新订单创建budget_orders草稿
    let createdCount = 0
    for (const o of newOrders) {
      // Wave 3-C P1-E2: 用 RPC 把 lookup-or-create 串行化（pg_advisory_xact_lock 防 race）
      let customerId: string | null = null
      if (o.customer_name) {
        const { data: cust, error: custErr } = await finance.rpc('get_or_create_customer' as never, {
          p_name: o.customer_name,
          p_currency: o.currency || 'USD',
        } as never) as any
        if (custErr) {
          // 不抛错，按 manual_review 处理（保留可见性）
          console.error('[sync] get_or_create_customer 失败:', custErr.message)
        } else if (cust?.id) {
          customerId = cust.id as string
        }
      }

      // 查找已有budget_order（避免重复）：用 synced_orders 结构化字段精确匹配同一节拍器单号，
      // 复用其 budget_order_id（webhook 或历史同步已建）。不再用 notes 子串 ILIKE（QM1 会误命中
      // QM12/QM100、notes 被编辑后失效——qimo 上量后会重复建单/错关联）。
      const { data: linkedSynced } = await finance
        .from('synced_orders')
        .select('budget_order_id')
        .eq('order_no', o.order_no)
        .not('budget_order_id', 'is', null)
        .limit(1)
        .maybeSingle()

      if (linkedSynced?.budget_order_id) {
        // 已有，只需关联本行
        await finance.from('synced_orders').update({ budget_order_id: linkedSynced.budget_order_id }).eq('id', o.id)
        continue
      }

      // 创建者 = 触发同步的登录人（UI 按钮触发，有会话）；机器调用(x-api-key)记 null，
      // 不冒用"第一个 profile"（防审计归属伪造）。注意 finance 是 service 客户端无会话，
      // 会话取自路由开头的 sessionUser。
      const createdBy = sessionUser?.user?.id ?? null

      if (!customerId) continue

      const totalAmount = Number(o.total_amount) || (Number(o.unit_price || 0) * Number(o.quantity || 0))

      const { data: newBO } = await finance.from('budget_orders').insert({
        order_no: '',
        customer_id: customerId,
        total_revenue: totalAmount,
        currency: o.currency || 'USD',
        exchange_rate: null, // 同步时不知道实际汇率，需财务人员手动补填
        status: 'draft',
        order_date: bizToday(),
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
