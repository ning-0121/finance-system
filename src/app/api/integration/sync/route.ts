// POST /api/integration/sync
// 从节拍器【签名 HTTP 只读 API】拉取最新订单，同步到财务系统。
// 审计 P0-1 已收尾：彻底移除"直连节拍器 Supabase"后门(不再持有对方 service key)，
// 唯一通道是 fetchAllOrdersFromMetronome(签名+时间戳窗口，读的是节拍器暴露的 /api/integration/orders)。
import { bizToday } from '@/lib/biz-date'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyApiKey } from '@/lib/integration/security'
import { fetchAllOrdersFromMetronome } from '@/lib/integration/client'
import { reverseOrder, isDeadLifecycle } from '@/lib/integration/order-reversal'
import type { SyncedOrder } from '@/lib/integration/types'

// 节拍器订单镜像字段（签名 API 返回）
type MetOrder = {
  id: string; order_no: string; internal_order_no: string | null; customer_name: string | null
  factory_name: string | null; quantity: number | null; quantity_unit: string | null; currency: string | null
  total_amount: number | null; unit_price: number | null; incoterm: string | null; delivery_type: string | null
  order_type: string | null; lifecycle_status: string | null; po_number: string | null; etd: string | null
  payment_terms: string | null; notes: string | null; created_at: string; updated_at: string
}

export const maxDuration = 300   // 全量拉取对账可能较久(cron 兜底调用),默认时长会被掐断

export async function POST(request: Request) {

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

    // 1. 读取节拍器所有订单 —— 签名 HTTP 只读 API（唯一合规通道，不碰对方 Supabase）
    const r = await fetchAllOrdersFromMetronome()
    if (!r.success) throw new Error(`签名同步失败: ${r.error}`)
    const metronomeOrders = (r.data || []) as unknown as MetOrder[]

    if (!metronomeOrders.length) {
      return NextResponse.json({ synced: 0, created: 0, message: '节拍器无订单' })
    }

    // 2. 读取已同步的订单（含 budget_order_id：用于识别"已同步但草稿未建成"的孤儿单）
    const { data: existingSynced } = await finance
      .from('synced_orders')
      .select('id, order_no, style_no, budget_order_id, lifecycle_status')

    const syncedMap = new Map<string, string>()
    const draftMissing = new Set<string>()   // 已同步但无预算草稿的 order_no
    const prevLifecycle = new Map<string, string>()   // 上一轮镜像状态,用于识别「本轮变成死单」
    existingSynced?.forEach(s => {
      if (s.order_no) {
        syncedMap.set(s.order_no, s.id)
        if (!s.budget_order_id) draftMissing.add(s.order_no)
        prevLifecycle.set(s.order_no, String(s.lifecycle_status || ''))
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

    // 4.5 死单级联(2026-08-01):节拍器把订单取消/删除,但没发(或漏发)webhook 时,
    //   状态只能靠本同步刷进来。此前刷完就完了 —— 预算草稿/采购审批/未决审批全留着,
    //   财务列表照常显示"已删除"的单(生产实证 1022978 QM-20260731-001:全程只有
    //   order.created 一条事件,镜像 cancelled,草稿 BO-202608-0001 一直存活)。
    //   现在复用 webhook 同一套保守冲销 reverseOrder(唯一实现,避免两条路径再次走偏)。
    //
    // ⚠️ 触发条件不能只看「本轮由活变死」(2026-08-03 修正):
    //   那样只能抓到状态跳变的那一次,镜像里【早就是死单】但预算仍存活的存量
    //   永远抓不到 —— 审计实证 QM-20260717-002(内部号 1022222)镜像 cancelled、
    //   草稿 BO-202607-0109 一直活着,正是被上一版条件漏掉的。
    //   改为:死单 且 其预算单仍未软删 → 冲销。天然覆盖「跳变」与「存量」两种,
    //   且清理完后条件自动不成立,不会每 6 小时重复空跑。
    const budgetAlive = new Map<string, boolean>()
    {
      const bids = [...new Set(existingSynced?.map(s => s.budget_order_id).filter(Boolean) as string[] || [])]
      for (let i = 0; i < bids.length; i += 500) {
        const { data } = await finance.from('budget_orders').select('id, deleted_at').in('id', bids.slice(i, i + 500))
        for (const b of data || []) budgetAlive.set(b.id as string, !b.deleted_at)
      }
    }
    const budgetIdOf = new Map((existingSynced || []).map(s => [s.order_no as string, s.budget_order_id as string | null]))
    const reversals: string[] = []
    for (const o of metronomeOrders) {
      if (!syncedMap.has(o.order_no)) continue          // 新单在下面按 DEAD 守卫处理,不在这里冲销
      if (!isDeadLifecycle(o.lifecycle_status)) continue
      const bid = budgetIdOf.get(o.order_no)
      const wasDead = isDeadLifecycle(prevLifecycle.get(o.order_no))
      // 已是死单 且 预算也已作废(或压根没预算)→ 没什么可冲销的,跳过,避免每轮空跑
      if (wasDead && !(bid && budgetAlive.get(bid))) continue
      try {
        const r = await reverseOrder(
          finance,
          { ...o, id: syncedMap.get(o.order_no)! } as unknown as SyncedOrder,
          'sync.cancelled',
        )
        if (r.actions.length) reversals.push(`${o.order_no}: ${r.actions.join('、')}`)
      } catch (e) {
        // 单单失败不阻断整轮同步
        reversals.push(`${o.order_no}: 冲销异常 ${e instanceof Error ? e.message : e}`)
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
    // ⚠️ 死单守卫(2026-08-01):已取消/已删除的订单不建预算草稿 —— 否则同步会给"已经没了"的
    //   订单凭空造一张草稿,财务列表里冒出个 ¥0 空壳单还删不掉(1022978 就是这么来的:
    //   节拍器 7-31 建单、8-01 前取消,同步当孤儿单补建了 BO-202608-0001)。
    //   webhook 建预算路径早有同款守卫(DEAD 列表),此处补齐,两条路径口径一致。
    const deadSkipped = [...newOrders, ...orphanOrders].filter(o => isDeadLifecycle(o.lifecycle_status))
    const needDraft = [...newOrders, ...orphanOrders].filter(o => !isDeadLifecycle(o.lifecycle_status))
    if (needDraft.length === 0) {
      return NextResponse.json({
        synced: 0, created: 0, updated: updatedCount, total: metronomeOrders.length,
        reversed: reversals.length, reversals,
        dead_skipped: deadSkipped.length,
        message: `已更新${updatedCount}个订单状态${reversals.length ? `,冲销${reversals.length}张死单` : ''}${deadSkipped.length ? `,跳过${deadSkipped.length}张死单不建草稿` : ''}`,
      })
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

      // P0-1 止血静默丢弃:无客户名/客户匹配失败 → 建不了预算单。此前直接 continue、无任何痕迹
      //（与 no_amount_skipped 同类静默丢弃)。改为:标记 synced_orders、计入返回 failures、并留一条
      // integration_logs 告警,让财务看得到「这单没进预算,原因=客户」而非凭空消失。
      if (!customerId) {
        createFailures.push({ order_no: o.order_no, error: `客户匹配失败或无客户名(customer=${o.customer_name || '空'})` })
        try {
          await finance.from('synced_orders').update({ budget_sync_status: 'customer_unmatched' }).eq('id', o.id)
          await finance.from('integration_logs').insert({
            event_type: 'sync.customer_unmatched', direction: 'inbound',
            request_id: `sync-nocust-${o.id}-${Date.now()}`, source: 'finance-sync', status: 'warning',
            payload_summary: `订单 ${o.order_no} 客户「${o.customer_name || '空'}」匹配失败,未建预算单,财务收不到该单,请人工核对客户`,
          })
        } catch (e) { console.error('[sync] 记录 customer_unmatched 失败:', e) }
        continue
      }

      const totalAmount = Number(o.total_amount) || (Number(o.unit_price || 0) * Number(o.quantity || 0))

      const cur = o.currency || 'USD'
      const { data: newBO, error: boErr } = await finance.from('budget_orders').insert({
        order_no: '',
        qimo_order_id: o.id,   // 审计 P1:绮陌订单 UUID 结构化落库
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
      // 死单处理明细:冲销了几张、跳过不建草稿几张(不静默,便于对账为什么数量对不上)
      reversed: reversals.length,
      reversals: reversals.slice(0, 20),
      dead_skipped: deadSkipped.length,
      newOrders: needDraft.map(o => ({ order_no: o.order_no, internal: o.internal_order_no, customer: o.customer_name })),
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
