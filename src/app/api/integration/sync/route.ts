// POST /api/integration/sync
// 从节拍器Supabase主动拉取最新订单，同步到财务系统
import { bizToday } from '@/lib/biz-date'
import { NextResponse } from 'next/server'
import { createClient as createMetronomeClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyApiKey } from '@/lib/integration/security'
import { fetchAllOrdersFromMetronome } from '@/lib/integration/client'

const METRONOME_URL = process.env.METRONOME_SUPABASE_URL || ''
const METRONOME_KEY = process.env.METRONOME_SUPABASE_SERVICE_KEY || ''
// 审计 P0-1：拔掉直连节拍器 Supabase 的后门。开关打开=走签名 HTTP 只读 API(合规通道)，
// 关闭=旧的直连(过渡期保留，节拍器列表 API 上线并灰度验证后即可删除下方 legacy 分支+环境变量)。
const USE_SIGNED_SYNC = process.env.SYNC_VIA_SIGNED_API === '1'

// 节拍器订单镜像字段（直连 select 与签名 API 返回同构）
type MetOrder = {
  id: string; order_no: string; internal_order_no: string | null; customer_name: string | null
  factory_name: string | null; quantity: number | null; quantity_unit: string | null; currency: string | null
  total_amount: number | null; unit_price: number | null; incoterm: string | null; delivery_type: string | null
  order_type: string | null; lifecycle_status: string | null; po_number: string | null; etd: string | null
  payment_terms: string | null; notes: string | null; created_at: string; updated_at: string
}

export async function POST(request: Request) {
  if (!USE_SIGNED_SYNC && (!METRONOME_URL || !METRONOME_KEY)) {
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
    // 写库用 service 客户端（集成路由标准形态，与 webhook 一致）——
    // synced_orders/budget_orders 的 RLS 写策略要求财务角色会话，服务端同步不应受其约束
    const finance = createServiceClient()

    // 1. 读取节拍器所有订单
    //    合规通道(USE_SIGNED_SYNC)：签名 HTTP 只读 API，不碰对方 Supabase。
    //    legacy 通道：直连节拍器 Supabase(审计 P0-1，待删)。
    let metronomeOrders: MetOrder[]
    if (USE_SIGNED_SYNC) {
      const r = await fetchAllOrdersFromMetronome()
      if (!r.success) throw new Error(`签名同步失败: ${r.error}`)
      metronomeOrders = (r.data || []) as unknown as MetOrder[]
    } else {
      const metronome = createMetronomeClient(METRONOME_URL, METRONOME_KEY)
      const { data, error: readErr } = await metronome
        .from('orders')
        .select('id, order_no, internal_order_no, customer_name, factory_name, quantity, quantity_unit, currency, total_amount, unit_price, incoterm, delivery_type, order_type, lifecycle_status, po_number, etd, payment_terms, notes, created_at, updated_at')
        .order('created_at', { ascending: false })
      if (readErr) throw new Error(`读取节拍器失败: ${readErr.message}`)
      metronomeOrders = (data || []) as unknown as MetOrder[]
    }

    if (!metronomeOrders.length) {
      return NextResponse.json({ synced: 0, created: 0, message: '节拍器无订单' })
    }

    // 2. 读取已同步的订单（含 budget_order_id：用于识别"已同步但草稿未建成"的孤儿单）
    const { data: existingSynced } = await finance
      .from('synced_orders')
      .select('id, order_no, style_no, budget_order_id')

    const syncedMap = new Map<string, string>()
    const draftMissing = new Set<string>()   // 已同步但无预算草稿的 order_no
    existingSynced?.forEach(s => {
      if (s.order_no) {
        syncedMap.set(s.order_no, s.id)
        if (!s.budget_order_id) draftMissing.add(s.order_no)
      }
    })

    // 3. 找出未同步的新订单 + 草稿缺失的孤儿单（此前草稿插入失败被吞，需自愈补建）
    const newOrders = metronomeOrders.filter(o => !syncedMap.has(o.order_no))
    const orphanOrders = metronomeOrders.filter(o => draftMissing.has(o.order_no))

    // 4. 更新已有订单（逐条update避免唯一约束冲突）——全字段重刷：
    // 此前只刷 状态/款号/客户/数量，金额/单价/交期/付款条款等在 webhook 断链期的
    // 变更会永久滞留旧值；现在把镜像字段全部刷新 + 维护 source_updated_at
    let updatedCount = 0
    for (const o of metronomeOrders) {
      if (syncedMap.has(o.order_no)) {
        await finance.from('synced_orders').update({
          style_no: o.internal_order_no || '',
          lifecycle_status: o.lifecycle_status || 'draft',
          customer_name: o.customer_name || '',
          quantity: o.quantity,
          quantity_unit: o.quantity_unit || '件',
          currency: o.currency || 'USD',   // 审计 P2:此前全字段重刷漏了币种,断链期改币刷不回来
          unit_price: o.unit_price,
          total_amount: o.total_amount,
          factory_name: o.factory_name,
          incoterm: o.incoterm,
          delivery_type: o.delivery_type,
          order_type: o.order_type,
          po_number: o.po_number,
          etd: o.etd,
          payment_terms: o.payment_terms,
          notes: o.notes,
          source_updated_at: o.updated_at,
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

    // 待建草稿 = 新订单 + 已同步但草稿缺失的孤儿单（自愈：草稿插入失败后重跑同步即可补建）
    const needDraft = [...newOrders, ...orphanOrders]
    if (needDraft.length === 0) {
      return NextResponse.json({ synced: 0, created: 0, updated: updatedCount, total: metronomeOrders.length, message: `已更新${updatedCount}个订单状态` })
    }

    // 5. 为新订单/孤儿单创建budget_orders草稿
    let createdCount = 0
    const createFailures: { order_no: string; error: string }[] = []
    for (const o of needDraft) {
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

      const cur = o.currency || 'USD'
      const { data: newBO, error: boErr } = await finance.from('budget_orders').insert({
        order_no: '',
        customer_id: customerId,
        total_revenue: totalAmount,
        currency: cur,
        // CNY 恒 1；外币同步时不知道实际汇率 → null 待财务补填（审批门槛会拦无汇率外币单）
        exchange_rate: cur === 'CNY' ? 1 : null,
        status: 'draft',
        order_date: bizToday(),
        created_by: createdBy,
        notes: `来源: 订单节拍器 节拍器订单号: ${o.order_no} 内部单号: ${o.internal_order_no || ''} 客户: ${o.customer_name || ''} 数量: ${o.quantity || ''}${o.quantity_unit || '件'}`,
        has_sub_documents: false,
      }).select('id').single()

      if (boErr) {
        // 此前错误被静默吞掉(NOT NULL 约束失败时 created 恒 0 而无人知晓)——收集并返回
        createFailures.push({ order_no: o.order_no, error: boErr.message })
        continue
      }
      if (newBO) {
        // 原子认领：与 webhook 并发时只允许一个草稿胜出(此前竞态会建两张草稿,审计 P1)。
        // 财务表禁物理删，落败草稿软删。
        const { data: claim } = await finance.from('synced_orders')
          .update({ budget_order_id: newBO.id })
          .eq('id', o.id).is('budget_order_id', null)
          .select('id')
        if (claim && claim.length > 0) {
          createdCount++
        } else {
          await finance.from('budget_orders').update({
            deleted_at: new Date().toISOString(), delete_reason: '并发重复草稿自动清理(原子认领落败)',
          }).eq('id', newBO.id)
        }
      }
    }

    return NextResponse.json({
      synced: newOrders.length,
      orphansRepaired: orphanOrders.length,
      created: createdCount,
      failed: createFailures.length,
      failures: createFailures.slice(0, 10),
      total: metronomeOrders.length,
      newOrders: needDraft.map(o => ({ order_no: o.order_no, internal: o.internal_order_no, customer: o.customer_name })),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
