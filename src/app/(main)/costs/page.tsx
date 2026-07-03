'use client'

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Plus, Loader2, Receipt, TrendingUp, Package, Ship, FileText, DollarSign, Upload, Search } from 'lucide-react'
import { ExcelImportDialog } from '@/components/import/ExcelImportDialog'
import { toast } from 'sonner'
import { getBudgetOrders } from '@/lib/supabase/queries'
import { getSuppliers } from '@/lib/supabase/queries-v2'
import { getFabricPriceReference, getProcessingPriceReference, type PriceReference } from '@/lib/supabase/price-history'
import { normalizeSupplierName } from '@/lib/utils'
import { bizToday } from '@/lib/biz-date'
import { createClient } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import type { BudgetOrder, CostType } from '@/lib/types'
import { validateCostEntry, type ValidationWarning } from '@/lib/engines/validation-engine'
import { allocateAmountByOrderQty } from '@/lib/engines/cost-allocation'
import { BudgetOverview } from './BudgetOverview'
import { TaxPointOverview } from './TaxPointOverview'

// 录入单位下拉选项（统一口径，避免 件/kg/公斤 混录导致决算按单位拆行）
const UNIT_OPTIONS = ['件', '米', '千克', '个']
const unitOptionsWith = (v?: string) => (v && !UNIT_OPTIONS.includes(v) ? [v, ...UNIT_OPTIONS] : UNIT_OPTIONS)

const costTypeConfig: Record<CostType, { label: string; icon: typeof Ship; color: string }> = {
  fabric: { label: '面料', icon: Package, color: 'bg-rose-100 text-rose-700' },
  accessory: { label: '辅料', icon: Package, color: 'bg-pink-100 text-pink-700' },
  processing: { label: '加工费', icon: Receipt, color: 'bg-orange-100 text-orange-700' },
  freight: { label: '货代费', icon: Ship, color: 'bg-blue-100 text-blue-700' },
  container: { label: '装柜费', icon: Package, color: 'bg-cyan-100 text-cyan-700' },
  logistics: { label: '物流费', icon: Ship, color: 'bg-teal-100 text-teal-700' },
  commission: { label: '佣金', icon: DollarSign, color: 'bg-green-100 text-green-700' },
  customs: { label: '报关费', icon: FileText, color: 'bg-purple-100 text-purple-700' },
  procurement: { label: '其他采购', icon: Package, color: 'bg-amber-100 text-amber-700' },
  other: { label: '其他', icon: Receipt, color: 'bg-gray-100 text-gray-700' },
  // 票点=供应商开票费用：不计预算/决算/毛利/GL成本(留作出口退税核算)，仍计应付与供应商对账
  tax_point: { label: '票点(不计成本)', icon: FileText, color: 'bg-slate-200 text-slate-700' },
}

interface CostRecord {
  id: string
  budget_order_id: string | null
  order_no?: string
  supplier?: string
  cost_type: CostType
  description: string
  amount: number
  currency: string
  exchange_rate: number
  is_paid: boolean
  detail_meta?: { qty: number; unit: string; unit_price: number }
  color?: string | null
  roll_count?: number | null
  delivery_date?: string | null // 送货日期（财务对账用，可自选；区别于录入时间）
  created_at: string
}

// 空数据占位（不再显示假数据）
const demoCostItems: CostRecord[] = []

export default function CostsPage() {
  const [costItems, setCostItems] = useState<CostRecord[]>(demoCostItems)
  const [orders, setOrders] = useState<BudgetOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('all')

  // 新费用表单
  const [formType, setFormType] = useState<CostType>('fabric')
  const [formOrderId, setFormOrderId] = useState('')
  const [orderSearch, setOrderSearch] = useState('')
  const [showOrderList, setShowOrderList] = useState(false)
  const [formSupplier, setFormSupplier] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formQty, setFormQty] = useState('')
  const [formUnitPrice, setFormUnitPrice] = useState('')
  const [formUnit, setFormUnit] = useState('件')
  const [formColor, setFormColor] = useState('')       // 颜色（面料等）
  const [priceRef, setPriceRef] = useState<PriceReference | null>(null)  // 历史比价（布料按品名+颜色、加工费按款号）
  const [priceRefLoading, setPriceRefLoading] = useState(false)
  const [formRollCount, setFormRollCount] = useState('') // 匹数
  const [formDeliveryDate, setFormDeliveryDate] = useState(bizToday()) // 送货日期（可自选，默认今天）
  const [formAmount, setFormAmount] = useState('')
  const [formCurrency, setFormCurrency] = useState('CNY')
  const [formRate, setFormRate] = useState('1')
  const [formPaid, setFormPaid] = useState(false)
  const [editItem, setEditItem] = useState<CostRecord | null>(null)
  /** 单订单录入 | 多订单按件数比例分摊 */
  const [entryMode, setEntryMode] = useState<'single' | 'shared'>('single')
  const [sharedOrderIds, setSharedOrderIds] = useState<string[]>([])
  // 多行明细（同一供应商多个品目）
  const [extraLines, setExtraLines] = useState<{ desc: string; color: string; roll: string; qty: string; unit: string; unitPrice: string; amount: string }[]>([])
  // 防错校验
  const [validationWarnings, setValidationWarnings] = useState<ValidationWarning[]>([])
  const [showConfirm, setShowConfirm] = useState(false)

  const [syncedOrderMap, setSyncedOrderMap] = useState<Record<string, string>>({}) // budget_order_id → QM订单号
  const [syncedQtyMap, setSyncedQtyMap] = useState<Record<string, number>>({}) // budget_order_id → 订单数量(分摊权重)
  const [supplierAliases, setSupplierAliases] = useState<Record<string, string>>({}) // 旧名→标准名(归并登记)
  // 供应商画像主数据（录入费用时供应商从这里选，可输入筛选）
  const [supplierMasters, setSupplierMasters] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const ordersData = await getBudgetOrders()
        setOrders(ordersData)
        getSuppliers().then(ms => setSupplierMasters(ms.map(m => ({ id: m.id, name: m.name })))).catch(() => {})
        // 加载synced_orders获取内部单号+QM号+客户映射
        const supabase2 = createClient()
        // 供应商别名映射（归并登记的旧名→标准名）：录入时自动纠正，防止归并后又裂开
        supabase2.from('supplier_aliases').select('alias, canonical_name').then(({ data: al }) => {
          if (al) setSupplierAliases(Object.fromEntries(al.map(a => [String(a.alias).trim(), String(a.canonical_name)])))
        })
        const { data: syncedOrders } = await supabase2.from('synced_orders').select('order_no, budget_order_id, style_no, customer_name, quantity').not('budget_order_id', 'is', null)
        if (syncedOrders) {
          const map: Record<string, string> = {}
          const qtyMap: Record<string, number> = {}
          syncedOrders.forEach((s: Record<string, unknown>) => {
            if (s.budget_order_id) {
              const internal = s.style_no ? `${s.style_no} | ` : ''
              const customer = s.customer_name ? ` - ${s.customer_name}` : ''
              map[s.budget_order_id as string] = `${internal}${s.order_no as string}${customer}`
              // 多订单分摊权重用真实订单数量(synced_orders.quantity)——budget_orders.items 里无数量
              qtyMap[s.budget_order_id as string] = Number(s.quantity) || 0
            }
          })
          setSyncedOrderMap(map)
          setSyncedQtyMap(qtyMap)
        }

        // 尝试从Supabase加载费用（分页取全量，防 1000 行截断；排除已软删；报错不静默）
        const supabase = createClient()
        const { data, error } = await fetchAll<Record<string, unknown>>((from, to) => supabase
          .from('cost_items')
          .select('*, budget_orders(order_no)')
          .is('deleted_at', null)
          .order('created_at', { ascending: false }).order('id', { ascending: true })
          .range(from, to))
        if (error) toast.error(`费用台账加载失败：${error.message}`)

        if (data && data.length > 0) {
          setCostItems(data.map((r: Record<string, unknown>) => {
            // 明细优先读真实列（quantity/unit/unit_price，与订单核算单口径一致）；
            // 真实列缺失再退回历史 source_id JSON，兼容回填/历史数据两种来源。
            let detailMeta: { qty: number; unit: string; unit_price: number } | undefined
            if (r.quantity != null || r.unit_price != null) {
              detailMeta = { qty: Number(r.quantity) || 0, unit: (r.unit as string) || '', unit_price: Number(r.unit_price) || 0 }
            } else {
              try { if (r.source_id) detailMeta = JSON.parse(r.source_id as string) } catch { /* not json */ }
            }
            return {
              id: r.id as string,
              budget_order_id: r.budget_order_id as string | null,
              order_no: (r.budget_orders as Record<string, unknown>)?.order_no as string | undefined,
              supplier: (r.supplier as string) || undefined,
              cost_type: r.cost_type as CostType,
              description: r.description as string,
              amount: r.amount as number,
              currency: r.currency as string,
              exchange_rate: r.exchange_rate as number,
              is_paid: r.source_module === 'paid',
              detail_meta: detailMeta,
              color: (r.color as string) || null,
              roll_count: r.roll_count != null ? Number(r.roll_count) : null,
              delivery_date: (r.delivery_date as string) || null,
              created_at: r.created_at as string,
            }
          }))
        }
      } catch {
        // fallback to demo
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // 历史比价：录入布料(品名+颜色)/加工费(款号)时实时拉历史同款价（防抖 400ms）
  useEffect(() => {
    if (!showAdd || (formType !== 'fabric' && formType !== 'processing')) { setPriceRef(null); return }
    const key = formType === 'fabric' ? `f:${formDesc}|${formColor}` : `p:${formOrderId}`
    if (formType === 'fabric' ? !formDesc.trim() : !formOrderId) { setPriceRef(null); return }
    let alive = true
    setPriceRefLoading(true)
    const timer = setTimeout(async () => {
      try {
        const ref = formType === 'fabric'
          ? await getFabricPriceReference(formDesc, formColor, editItem?.budget_order_id || undefined)
          : await getProcessingPriceReference(formOrderId, editItem?.budget_order_id || undefined)
        if (alive) setPriceRef(ref)
      } catch { if (alive) setPriceRef(null) }
      finally { if (alive) setPriceRefLoading(false) }
    }, 400)
    return () => { alive = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAdd, formType, formDesc, formColor, formOrderId])

  const [costSearch, setCostSearch] = useState('')

  // 支持 /costs?q=单号 直达搜索（订单详情"实际归集N行"跳转用）；
  // 用 window.location 而非 useSearchParams，避免 App Router 的 Suspense 约束
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) setCostSearch(q)
  }, [])

  // 搜索匹配（订单号、供应商、描述）——列表过滤与分类统计共用
  const matchesSearch = (c: CostRecord) => {
    if (!costSearch) return true
    const q = costSearch.toLowerCase()
    const orderLabel = c.budget_order_id ? (syncedOrderMap[c.budget_order_id] || c.order_no || '') : ''
    return (
      (c.supplier || '').toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      orderLabel.toLowerCase().includes(q) ||
      (c.order_no || '').toLowerCase().includes(q)
    )
  }

  const filteredItems = costItems.filter(c => {
    // tab筛选
    if (tab === 'unlinked' && c.budget_order_id) return false
    if (tab !== 'all' && tab !== 'unlinked' && c.cost_type !== tab) return false
    return matchesSearch(c)
  })

  // 统计：搜索时分类徽章/合计跟随搜索范围（如搜单号→该订单的费用合计），未搜索为全局
  const searchedItems = costSearch ? costItems.filter(matchesSearch) : costItems
  const totalAmount = costItems.reduce((s, c) => s + c.amount, 0)
  const searchedAmount = searchedItems.reduce((s, c) => s + c.amount, 0)
  const unlinkedCount = costItems.filter(c => !c.budget_order_id).length
  const byType = Object.entries(costTypeConfig).map(([type, cfg]) => {
    const items = searchedItems.filter(c => c.cost_type === type)
    return { type, ...cfg, count: items.length, total: items.reduce((s, c) => s + c.amount, 0) }
  }).filter(t => t.count > 0)

  // 防错校验 → 有error阻止，有warning弹确认
  const runValidation = useCallback(() => {
    const amt = Number(formAmount) || 0
    let orderRevenue: number | undefined
    if (entryMode === 'shared' && sharedOrderIds.length > 0) {
      orderRevenue = sharedOrderIds.reduce((s, id) => {
        const o = orders.find(x => x.id === id)
        return s + (o ? o.total_revenue * (o.exchange_rate || 1) : 0)
      }, 0)
    } else {
      const order = orders.find(o => o.id === formOrderId)
      orderRevenue = order ? order.total_revenue * (order.exchange_rate || 1) : undefined
    }
    const warnings = validateCostEntry({
      amount: amt,
      description: formDesc,
      supplier: formSupplier.trim(),
      costType: formType,
      currency: formCurrency,
      exchangeRate: Number(formRate) || 1,
      orderRevenue,
      existingCosts: costItems.map(c => ({ supplier: c.supplier || '', description: c.description, amount: c.amount })),
    })
    return warnings
  }, [formAmount, formDesc, formSupplier, formType, formCurrency, formRate, formOrderId, orders, costItems, entryMode, sharedOrderIds])

  const handleSaveWithValidation = () => {
    // 备注(原「费用描述」)改为可选：空时用 供应商名 / 费用类型 兜底，保证决算按名聚合可读
    if (!formAmount || Number(formAmount) <= 0) { toast.error('请输入有效金额'); return }
    if (!editItem && entryMode === 'shared' && sharedOrderIds.length < 2) {
      toast.error('多订单分摊请至少选择 2 个订单')
      return
    }

    // 自动trim供应商名称
    if (formSupplier !== formSupplier.trim()) setFormSupplier(formSupplier.trim())

    const warnings = runValidation()
    setValidationWarnings(warnings)

    const errors = warnings.filter(w => w.level === 'error')
    if (errors.length > 0) {
      toast.error(errors[0].message)
      return
    }

    const needsConfirm = warnings.filter(w => w.level === 'warning')
    if (needsConfirm.length > 0) {
      setShowConfirm(true) // 显示确认弹窗
      return
    }

    handleSave() // 无警告直接保存
  }

  const handleSave = async () => {
    setShowConfirm(false)
    setSaving(true)
    try {
      const supabase = createClient()
      // created_by 必须是真实登录人（旧实现取"表里第一个 profile"会伪造审计归属）
      const { data: userData } = await supabase.auth.getUser()
      const createdBy = userData?.user?.id
      if (!createdBy) { toast.error('登录态已失效，请重新登录后再录入'); setSaving(false); return }
      // 别名自动归一：录入旧名(已归并)时自动改为标准名，防止归并后名字又裂开
      const aliasCanon = supplierAliases[formSupplier.trim()]
      if (aliasCanon && aliasCanon !== formSupplier.trim()) {
        setFormSupplier(aliasCanon)
        toast.info(`供应商「${formSupplier.trim()}」已归并，本次按标准名「${aliasCanon}」入账`)
      }
      const supplierFinal = (aliasCanon || formSupplier).trim()

      if (!editItem && entryMode === 'shared') {
        if (sharedOrderIds.length < 2) {
          toast.error('请至少选择 2 个订单')
          setSaving(false)
          return
        }
        const totalAmt = Number(formAmount)
        if (!totalAmt || totalAmt <= 0) {
          toast.error('请输入有效总金额')
          setSaving(false)
          return
        }
        const splits = allocateAmountByOrderQty(totalAmt, sharedOrderIds, syncedQtyMap)
        const descBase = formDesc.trim() || formSupplier.trim() || '费用'
        const newRows: CostRecord[] = []
        for (const sp of splits) {
          const pctLabel = totalAmt > 0 ? ((sp.amount / totalAmt) * 100).toFixed(1) : '0'
          const desc = `${descBase}（多订单按件数分摊 · ${pctLabel}% · 权重件数 ${sp.qty}）`
          const metaObj: Record<string, unknown> = {
            shared_split: true,
            shared_qty_weight: sp.qty,
            shared_total_orders: sharedOrderIds.length,
          }
          if (formQty || formUnitPrice) {
            metaObj.qty = Number(formQty) || 0
            metaObj.unit = formUnit
            metaObj.unit_price = Number(formUnitPrice) || 0
          }
          const record = {
            budget_order_id: sp.orderId,
            cost_type: formType,
            description: desc,
            amount: sp.amount,
            currency: formCurrency,
            exchange_rate: Number(formRate),
            supplier: supplierFinal || null,
            source_module: formPaid ? 'paid' : null,
            source_id: JSON.stringify(metaObj),
            delivery_date: formDeliveryDate || null,
          }
          const res = await supabase.from('cost_items').insert({ ...record, created_by: createdBy }).select('*, budget_orders(order_no)').single()
          if (res.error) throw res.error
          const data = res.data as Record<string, unknown>
          let savedMeta: CostRecord['detail_meta']
          try {
            if (data.source_id) savedMeta = JSON.parse(data.source_id as string)
          } catch { /* */ }
          newRows.push({
            id: data.id as string,
            budget_order_id: data.budget_order_id as string | null,
            order_no: (data.budget_orders as Record<string, unknown>)?.order_no as string | undefined,
            supplier: data.supplier as string | undefined,
            cost_type: data.cost_type as CostType,
            description: data.description as string,
            amount: data.amount as number,
            currency: data.currency as string,
            exchange_rate: data.exchange_rate as number,
            is_paid: data.source_module === 'paid',
            detail_meta: savedMeta,
            created_at: data.created_at as string,
          })
        }
        setCostItems([...newRows, ...costItems])
        toast.success(`已按订单件数比例分摊录入 ${newRows.length} 笔`)
        setSaving(false)
        setShowAdd(false)
        setEntryMode('single')
        setSharedOrderIds([])
        setFormSupplier('')
        setFormDesc('')
        setFormQty('')
        setFormUnitPrice('')
        setFormUnit('件')
        setFormColor('')
        setFormRollCount('');        setFormDeliveryDate(bizToday())
        setFormAmount('')
        setFormOrderId('')
        setFormPaid(false)
        setExtraLines([])
        return
      }

      // 数量/单位/单价：写入真实列（订单核算单支区读取这几列）；同时保留 source_id JSON 兼容页面历史显示
      const qtyNum = Number(formQty) || 0
      const unitPriceNum = Number(formUnitPrice) || 0
      const detailMeta = (formQty || formUnitPrice) ? JSON.stringify({ qty: qtyNum, unit: formUnit, unit_price: unitPriceNum }) : null
      const record = {
        budget_order_id: formOrderId || null,
        cost_type: formType,
        description: formDesc.trim() || formSupplier.trim() || '费用',
        amount: Number(formAmount),
        currency: formCurrency,
        exchange_rate: Number(formRate),
        supplier: supplierFinal || null,
        source_module: formPaid ? 'paid' : null,
        source_id: detailMeta,
        quantity: (formQty || formUnitPrice) ? qtyNum : null,
        unit: (formQty || formUnitPrice) ? (formUnit || null) : null,
        unit_price: (formQty || formUnitPrice) ? unitPriceNum : null,
        color: formColor.trim() || null,
        roll_count: formRollCount ? Number(formRollCount) : null,
        delivery_date: formDeliveryDate || null,
      }

      let data: Record<string, unknown>
      let error: { message: string } | null

      if (editItem) {
        // 编辑模式：更新
        const res = await supabase.from('cost_items').update(record).eq('id', editItem.id).select('*, budget_orders(order_no)').single()
        data = res.data as Record<string, unknown>
        error = res.error
      } else {
        // 新建模式：插入
        const res = await supabase.from('cost_items').insert({ ...record, created_by: createdBy }).select('*, budget_orders(order_no)').single()
        data = res.data as Record<string, unknown>
        error = res.error
      }

      if (error) throw error

      // 2. 写后验证：回读确认数据存在
      const { data: verify } = await supabase.from('cost_items').select('id').eq('id', data.id).single()
      if (!verify) {
        console.error('[SaveGuard] cost_items写后验证失败: id=', data.id)
        toast.error('保存异常：数据写入但回读失败，请刷新页面')
        setSaving(false)
        return
      }

      let savedMeta: CostRecord['detail_meta']
      try { if (data.source_id) savedMeta = JSON.parse(data.source_id as string) } catch { /* not json */ }
      const savedItem: CostRecord = {
        id: data.id as string,
        budget_order_id: data.budget_order_id as string | null,
        order_no: (data.budget_orders as Record<string, unknown>)?.order_no as string | undefined,
        supplier: data.supplier as string | undefined,
        cost_type: data.cost_type as CostType,
        description: data.description as string,
        amount: data.amount as number,
        currency: data.currency as string,
        exchange_rate: data.exchange_rate as number,
        is_paid: data.source_module === 'paid',
        detail_meta: savedMeta,
        color: (data.color as string) || null,
        roll_count: data.roll_count != null ? Number(data.roll_count) : null,
        delivery_date: (data.delivery_date as string) || null,
        created_at: data.created_at as string,
      }
      // 保存额外明细行（编辑和新增模式都需要）
      const newItems: CostRecord[] = []
      let extraFailed = 0

      if (editItem) {
        setCostItems(costItems.map(c => c.id === editItem.id ? savedItem : c))
      } else {
        newItems.push(savedItem)
      }

      // 保存额外明细行（同一供应商的多个品目）
        for (const line of extraLines) {
          // 跳过空行，但如果有品名就尝试保存（金额可能需要从数量×单价计算）
          if (!line.desc) continue
          const lineAmount = Number(line.amount) || (Number(line.qty) * Number(line.unitPrice)) || 0
          if (lineAmount <= 0) { console.warn(`[费用录入] 品目"${line.desc}"金额为0，跳过`); continue }
          const lineQty = Number(line.qty) || 0
          const lineUnitPrice = Number(line.unitPrice) || 0
          const lineMeta = (line.qty || line.unitPrice) ? JSON.stringify({ qty: lineQty, unit: line.unit, unit_price: lineUnitPrice }) : null
          const { data: lineData, error: lineErr } = await supabase.from('cost_items').insert({
            budget_order_id: formOrderId || null,
            cost_type: formType,
            description: line.desc,
            amount: lineAmount,
            currency: formCurrency,
            exchange_rate: Number(formRate),
            supplier: supplierFinal || null,
            source_module: formPaid ? 'paid' : null,
            source_id: lineMeta,
            quantity: (line.qty || line.unitPrice) ? lineQty : null,
            unit: (line.qty || line.unitPrice) ? (line.unit || null) : null,
            unit_price: (line.qty || line.unitPrice) ? lineUnitPrice : null,
            color: line.color?.trim() || null,
            roll_count: line.roll ? Number(line.roll) : null,
            delivery_date: formDeliveryDate || null,
            created_by: createdBy,
          }).select('*, budget_orders(order_no)').single()

          if (lineErr) {
            console.error(`[费用录入] 品目"${line.desc}"保存失败:`, lineErr.message)
            extraFailed++
            continue
          }

          if (lineData) {
            let lm: CostRecord['detail_meta']
            try { if (lineData.source_id) lm = JSON.parse(lineData.source_id as string) } catch { /* */ }
            newItems.push({
              id: lineData.id as string,
              budget_order_id: lineData.budget_order_id as string | null,
              order_no: (lineData.budget_orders as Record<string, unknown>)?.order_no as string | undefined,
              supplier: lineData.supplier as string | undefined,
              cost_type: lineData.cost_type as CostType,
              description: lineData.description as string,
              amount: lineData.amount as number,
              currency: lineData.currency as string,
              exchange_rate: lineData.exchange_rate as number,
              is_paid: lineData.source_module === 'paid',
              detail_meta: lm,
              color: (lineData.color as string) || null,
              roll_count: lineData.roll_count != null ? Number(lineData.roll_count) : null,
              delivery_date: (lineData.delivery_date as string) || null,
              created_at: lineData.created_at as string,
            })
          }
        }
        if (extraFailed > 0) {
          toast.error(`${extraFailed} 条品目保存失败，请检查`)
        }

      if (newItems.length > 0) {
        setCostItems([...newItems, ...costItems])
      }
      const totalSaved = (editItem ? 1 : 0) + newItems.length
      toast.success(editItem ? `已更新，共保存 ${totalSaved} 条` : `已录入 ${newItems.length} 条费用`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('cost_type')) toast.error('费用类型不支持，请刷新页面后重试')
      else if (msg.includes('foreign key')) toast.error('关联的订单不存在，请检查')
      else if (msg.includes('not-null')) toast.error('必填字段为空')
      else toast.error(`保存失败: ${msg}`)
      console.error('[费用录入失败]', msg, { formType, formAmount, formCurrency, formRate, formOrderId })
      setSaving(false)
      return // 失败时不关闭弹窗，保留用户输入
    }
    // 成功后才关闭弹窗并清空表单
    setSaving(false)
    setShowAdd(false)
    setEditItem(null)
    setFormSupplier('')
    setFormDesc('')
    setFormQty('')
    setFormUnitPrice('')
    setFormUnit('件')
    setFormColor('')
    setFormRollCount('');    setFormDeliveryDate(bizToday())
    setFormAmount('')
    setFormOrderId('')
    setFormPaid(false)
    setExtraLines([])
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="费用归集" subtitle="面料·辅料·加工费·货代·装柜·物流·佣金，所有实际费用归集到订单" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-50"><Receipt className="h-4 w-4 text-blue-600" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">总费用笔数</p>
                  <p className="text-xl font-bold">{costItems.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-50"><TrendingUp className="h-4 w-4 text-green-600" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">总金额</p>
                  <p className="text-xl font-bold">¥{totalAmount.toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-amber-50"><Package className="h-4 w-4 text-amber-600" /></div>
                <div>
                  <p className="text-xs text-muted-foreground">已归集</p>
                  <p className="text-xl font-bold">{costItems.length - unlinkedCount}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className={unlinkedCount > 0 ? 'border-red-200' : ''}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${unlinkedCount > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <Receipt className={`h-4 w-4 ${unlinkedCount > 0 ? 'text-red-600' : 'text-gray-400'}`} />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">待归集</p>
                  <p className={`text-xl font-bold ${unlinkedCount > 0 ? 'text-red-600' : ''}`}>{unlinkedCount}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Type breakdown：搜索时跟随搜索范围（单订单合计），未搜索为全局 */}
        <div className="flex gap-2 flex-wrap items-center">
          {costSearch.trim() && (
            <Badge className="bg-primary/10 text-primary border-0 font-semibold">
              「{costSearch.trim()}」合计: {searchedItems.length}笔 ¥{searchedAmount.toLocaleString()}
            </Badge>
          )}
          {byType.map(t => (
            <Badge key={t.type} variant="outline" className={`${t.color} border-0 cursor-pointer`} onClick={() => setTab(t.type)}>
              <t.icon className="h-3 w-3 mr-1" />{t.label}: {t.count}笔 ¥{t.total.toLocaleString()}
            </Badge>
          ))}
          {costSearch.trim() && searchedItems.length === 0 && (
            <span className="text-xs text-muted-foreground">该搜索无费用记录</span>
          )}
        </div>

        {/* Actions + Table */}
        <div className="flex items-center justify-between">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="all">全部 ({costSearch ? `${filteredItems.length}/${costItems.length}` : costItems.length})</TabsTrigger>
              <TabsTrigger value="unlinked" className={unlinkedCount > 0 ? 'text-red-600' : ''}>
                待归集 ({unlinkedCount})
              </TabsTrigger>
              <TabsTrigger value="overview">预算总表</TabsTrigger>
              <TabsTrigger value="taxpoint">票点归集</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="搜索订单号/供应商/描述..." className="pl-8 h-8 w-[220px] text-sm" value={costSearch} onChange={e => setCostSearch(e.target.value)} />
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowImport(true)}>
              <Upload className="h-4 w-4 mr-1" />批量导入
            </Button>
            <Button size="sm" onClick={() => {
              setEditItem(null)
              setEntryMode('single')
              setSharedOrderIds([])
              setShowAdd(true)
            }}
            >
              <Plus className="h-4 w-4 mr-1" />录入费用
            </Button>
          </div>
        </div>

        {tab === 'overview' ? (
          <BudgetOverview costItems={costItems} />
        ) : tab === 'taxpoint' ? (
          <TaxPointOverview costItems={costItems} syncedOrderMap={syncedOrderMap} />
        ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>类型</TableHead>
                    <TableHead>供应商</TableHead>
                    <TableHead>描述</TableHead>
                    <TableHead>数量×单价</TableHead>
                    <TableHead>关联订单</TableHead>
                    <TableHead className="text-right">金额(¥)</TableHead>
                    <TableHead>付款</TableHead>
                    <TableHead>送货日期</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map(item => {
                    const cfg = costTypeConfig[item.cost_type]
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Badge variant="outline" className={`${cfg.color} border-0`}>
                            {cfg.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{item.supplier || '-'}</TableCell>
                        <TableCell className="max-w-[200px] truncate">{item.description}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.detail_meta ? `${item.detail_meta.qty}${item.detail_meta.unit}×¥${item.detail_meta.unit_price}` : '-'}
                        </TableCell>
                        <TableCell>
                          {item.budget_order_id ? (
                            <span className="text-primary font-medium text-xs">{syncedOrderMap[item.budget_order_id] || item.order_no || '-'}</span>
                          ) : (
                            <Badge variant="destructive" className="text-[10px]">待归集</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-semibold">¥{item.amount.toLocaleString()}</TableCell>
                        <TableCell>
                          <Badge variant={item.is_paid ? 'default' : 'outline'} className={item.is_paid ? 'bg-green-100 text-green-700 border-0' : 'text-amber-600'}>
                            {item.is_paid ? '已付' : '未付'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {/* 送货日期（财务对账口径）；历史数据无送货日期时回退录入日 */}
                          {item.delivery_date ? new Date(item.delivery_date + 'T00:00:00').toLocaleDateString('zh-CN') : new Date(item.created_at).toLocaleDateString('zh-CN')}
                        </TableCell>
                        <TableCell className="text-center space-x-1">
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => {
                            setEditItem(item)
                            setEntryMode('single')
                            setSharedOrderIds([])
                            setFormType(item.cost_type)
                            setFormSupplier(item.supplier || '')
                            setFormDesc(item.description)
                            setFormQty(item.detail_meta?.qty?.toString() || '')
                            setFormUnitPrice(item.detail_meta?.unit_price?.toString() || '')
                            setFormUnit(item.detail_meta?.unit || '件')
                            setFormColor(item.color || '')
                            setFormRollCount(item.roll_count != null ? String(item.roll_count) : '')
                            setFormDeliveryDate(item.delivery_date || item.created_at.slice(0, 10))
                            setFormAmount(item.amount.toString())
                            setFormCurrency(item.currency)
                            setFormRate(item.exchange_rate.toString())
                            setFormOrderId(item.budget_order_id || '')
                            setFormPaid(item.is_paid)
                            setShowAdd(true)
                          }}>编辑</Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500 hover:text-red-700" onClick={async () => {
                            // Wave 1-A：财务实体软删除，强制 actor + reason
                            const reason = prompt(`请输入删除这笔费用的原因（≥4 字符，将永久审计）：\n${item.description}\n金额: ${item.amount}`)
                            if (!reason || reason.trim().length < 4) {
                              if (reason !== null) toast.error('原因不能少于 4 字符')
                              return
                            }
                            const supabase = createClient()
                            const { data: user } = await supabase.auth.getUser()
                            if (!user?.user?.id) { toast.error('未登录'); return }
                            const { softDeleteFinancialEntity } = await import('@/lib/financial/soft-delete')
                            const result = await softDeleteFinancialEntity({
                              table: 'cost_items',
                              id: item.id,
                              actorId: user.user.id,
                              reason: reason.trim(),
                              sourcePage: 'costs/page.tsx',
                            })
                            if (result.ok) {
                              setCostItems(costItems.filter(c => c.id !== item.id))
                              toast.success(result.alreadyDeleted ? '该记录已于早前删除' : '已删除（审计已记录）')
                            } else {
                              toast.error(`删除失败: ${result.error}`)
                            }
                          }}>删除</Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {filteredItems.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                        {(() => {
                          // 智能空态：搜索无费用时检查订单库——"订单存在但没录过费用"和
                          // "订单不存在/未同步"是两回事，不区分会被误判成同步坏了
                          if (!costSearch.trim()) return '暂无费用记录'
                          const qq = costSearch.trim().toLowerCase()
                          const hit = orders.find(o => o.status !== 'rejected' && ((syncedOrderMap[o.id] || o.order_no).toLowerCase().includes(qq) || (o.customer?.company || '').toLowerCase().includes(qq)))
                          if (!hit) return `未找到含「${costSearch.trim()}」的费用或订单——请确认单号，或该订单尚未从订单系统同步`
                          return (
                            <span className="inline-flex items-center gap-2 flex-wrap justify-center">
                              <span>订单 <b className="text-foreground">{syncedOrderMap[hit.id] || hit.order_no}</b> 存在，但尚未录入任何费用</span>
                              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => {
                                setEditItem(null); setEntryMode('single'); setSharedOrderIds([])
                                setFormOrderId(hit.id); setShowAdd(true)
                              }}>为它录入费用</Button>
                            </span>
                          )
                        })()}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        )}
      </div>

      {/* 批量导入弹窗 */}
      <ExcelImportDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onSuccess={(count) => toast.success(`成功导入 ${count} 条费用记录`)}
      />

      {/* 录入费用弹窗 */}
      <Dialog open={showAdd} onOpenChange={(open) => {
        setShowAdd(open)
        if (!open) {
          setEditItem(null)
          setEntryMode('single')
          setSharedOrderIds([])
        }
      }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editItem ? '编辑费用' : '录入费用'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            {!editItem && (
              <div className="flex rounded-lg border p-1 bg-muted/40 gap-1">
                <button
                  type="button"
                  className={`flex-1 text-sm py-2 rounded-md transition-colors ${entryMode === 'single' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setEntryMode('single')}
                >
                  单订单
                </button>
                <button
                  type="button"
                  className={`flex-1 text-sm py-2 rounded-md transition-colors ${entryMode === 'shared' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => {
                    setEntryMode('shared')
                    setExtraLines([])
                    setFormOrderId('')
                  }}
                >
                  多订单分摊
                </button>
              </div>
            )}
            {entryMode === 'shared' && !editItem && (
              <div className="rounded-lg border p-3 space-y-2 max-h-[220px] overflow-y-auto">
                <Label className="text-xs text-muted-foreground">勾选多个订单，总金额将按各订单明细「件数」合计占比分配（件数均为 0 时平均分配）。仅排除"已拒绝"状态。</Label>
                <div className="space-y-1">
                  {orders.filter(o => o.status !== 'rejected').map(o => {
                    const checked = sharedOrderIds.includes(o.id)
                    const label = syncedOrderMap[o.id] || o.order_no
                    const q = syncedQtyMap[o.id] || 0
                    return (
                      <label key={o.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSharedOrderIds(prev =>
                              checked ? prev.filter(id => id !== o.id) : [...prev, o.id],
                            )
                          }}
                          className="rounded border-muted-foreground"
                        />
                        <span className="flex-1 truncate">{label}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{q} 件</span>
                      </label>
                    )
                  })}
                </div>
                {sharedOrderIds.length >= 2 && formAmount && Number(formAmount) > 0 && (
                  <div className="text-xs border-t pt-2 mt-2 space-y-1 text-muted-foreground">
                    <p className="font-medium text-foreground">预览分摊（¥{Number(formAmount).toLocaleString()}）</p>
                    {allocateAmountByOrderQty(Number(formAmount), sharedOrderIds, syncedQtyMap).map(s => {
                      const o = orders.find(x => x.id === s.orderId)
                      const lab = o ? (syncedOrderMap[o.id] || o.order_no) : s.orderId
                      return (
                        <div key={s.orderId} className="flex justify-between gap-2">
                          <span className="truncate">{lab}</span>
                          <span>¥{s.amount.toLocaleString()}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>费用类型</Label>
                <Select value={formType} onValueChange={(v) => setFormType((v || 'fabric') as CostType)}>
                  <SelectTrigger><SelectValue>{costTypeConfig[formType]?.label || formType}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {Object.entries(costTypeConfig).map(([key, cfg]) => (
                      <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>关联订单（输入搜索）</Label>
                <div className="relative">
                  <Input
                    placeholder="输入内部单号/订单号/客户名搜索..."
                    disabled={entryMode === 'shared' && !editItem}
                    value={formOrderId ? (syncedOrderMap[formOrderId] || orders.find(o => o.id === formOrderId)?.order_no || formOrderId) : orderSearch}
                    onChange={(e) => { setOrderSearch(e.target.value); setFormOrderId('') }}
                    onFocus={() => setShowOrderList(true)}
                  />
                  {showOrderList && !(entryMode === 'shared' && !editItem) && (() => {
                    const matched = orders.filter(o => {
                      if (o.status === 'rejected') return false
                      if (!orderSearch) return true
                      const label = syncedOrderMap[o.id] || o.order_no
                      return label.toLowerCase().includes(orderSearch.toLowerCase()) || (o.customer?.company || '').toLowerCase().includes(orderSearch.toLowerCase())
                    })
                    const DISPLAY_CAP = 50
                    const shown = matched.slice(0, DISPLAY_CAP)
                    const more = matched.length - shown.length
                    return (
                      <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border rounded-lg shadow-lg max-h-[300px] overflow-y-auto">
                        {shown.map(o => {
                          const label = syncedOrderMap[o.id] || o.order_no
                          return (
                            <button key={o.id} className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors" onClick={() => { setFormOrderId(o.id); setOrderSearch(''); setShowOrderList(false) }}>
                              {label}
                            </button>
                          )
                        })}
                        {orders.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">暂无订单</p>}
                        {matched.length === 0 && orders.length > 0 && <p className="px-3 py-2 text-sm text-muted-foreground">无匹配订单（已排除已拒绝）</p>}
                        {more > 0 && <p className="px-3 py-2 text-xs text-amber-600 bg-amber-50 border-t">还有 {more} 个匹配，请输入更精确的关键词缩小结果</p>}
                      </div>
                    )
                  })()}
                </div>
                {formOrderId && <button className="text-xs text-muted-foreground hover:text-red-500" onClick={() => setFormOrderId('')}>清除关联</button>}
                {entryMode === 'shared' && !editItem && (
                  <p className="text-xs text-muted-foreground">多订单模式请在上方勾选订单，此处无需选择。</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label>供应商</Label>
              {/* 读取「供应商画像」主数据，输入即筛选（datalist）；允许录入未建档供应商但给出提示 */}
              <Input list="cost-supplier-masters" placeholder="输入筛选供应商画像中的供应商" value={formSupplier} onChange={e => setFormSupplier(e.target.value)} />
              <datalist id="cost-supplier-masters">
                {supplierMasters.map(s => <option key={s.id} value={s.name} />)}
              </datalist>
              {formSupplier.trim() !== '' && supplierMasters.length > 0 && !supplierMasters.some(s => normalizeSupplierName(s.name) === normalizeSupplierName(formSupplier)) && (
                <p className="text-[11px] text-amber-600">「{formSupplier.trim()}」不在供应商画像中，仍可录入；建议先到供应商画像建档以统一名称（避免对账拆行）</p>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">颜色（可选）</Label>
                <Input placeholder="如：黑色 / 海军蓝" value={formColor} onChange={e => setFormColor(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">匹数（可选）</Label>
                <Input type="number" step="0.01" placeholder="0" value={formRollCount} onChange={e => setFormRollCount(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold">送货日期 *</Label>
                <Input type="date" value={formDeliveryDate} onChange={e => setFormDeliveryDate(e.target.value)} />
              </div>
            </div>
            {/* 数量/单位/单价/金额 一行四列；币种/汇率 另起一行——此前 6 个字段挤在 grid-cols-4
                里导致金额标签换行、数值显示不全 */}
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">数量</Label>
                <Input type="number" step="1" placeholder="0" value={formQty} onChange={e => {
                  setFormQty(e.target.value)
                  if (e.target.value && formUnitPrice) setFormAmount((Number(e.target.value) * Number(formUnitPrice)).toFixed(2))
                }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">单位</Label>
                <Select value={formUnit || '件'} onValueChange={v => setFormUnit(v || '件')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{unitOptionsWith(formUnit).map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">单价</Label>
                <Input type="number" step="0.01" placeholder="0.00" value={formUnitPrice} onChange={e => {
                  setFormUnitPrice(e.target.value)
                  if (e.target.value && formQty) setFormAmount((Number(formQty) * Number(e.target.value)).toFixed(2))
                }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold whitespace-nowrap">金额 *<span className="font-normal text-muted-foreground">（数量×单价自动算）</span></Label>
                <Input type="number" step="0.01" placeholder="0.00" value={formAmount} onChange={e => setFormAmount(e.target.value)} className="border-primary/30" />
              </div>
            </div>
            {/* 历史比价：布料(品名+颜色)/加工费(款号) 实时参考价 */}
            {(formType === 'fabric' || formType === 'processing') && (priceRefLoading || (priceRef && priceRef.count > 0)) && (() => {
              const curUnitCny = (Number(formUnitPrice) || 0) * (formCurrency === 'CNY' ? 1 : (Number(formRate) || 1))
              const overAvg = priceRef && priceRef.avgCny > 0 && curUnitCny > 0 && curUnitCny > priceRef.avgCny * 1.0001
              const overPct = overAvg && priceRef ? Math.round((curUnitCny / priceRef.avgCny - 1) * 100) : 0
              return (
                <div className={`rounded-lg p-3 text-xs space-y-1.5 border ${overAvg ? 'bg-red-50 border-red-300' : 'bg-blue-50/50 border-blue-200'}`}>
                  {priceRefLoading ? <p className="text-muted-foreground">查历史同款价中…</p> : priceRef && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{formType === 'fabric' ? '历史同款布料价' : '历史同款加工费'}（{priceRef.count} 笔）</span>
                        <span>最低 <b className="text-green-600">¥{priceRef.minCny.toLocaleString()}</b> · 均 <b>¥{priceRef.avgCny.toLocaleString()}</b> · 最高 <b className="text-red-500">¥{priceRef.maxCny.toLocaleString()}</b></span>
                      </div>
                      {overAvg && <p className="text-red-600 font-medium">⚠ 本次单价 ¥{curUnitCny.toLocaleString()} 高于历史均价 {overPct}%，请核对是否被加价</p>}
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                        {priceRef.items.slice(0, 6).map((it, i) => (
                          <span key={i}>{it.supplier}：¥{it.unitPriceCny.toLocaleString()}{it.unit ? `/${it.unit}` : ''} <span className="opacity-60">({it.date})</span></span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )
            })()}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">币种</Label>
                <Select value={formCurrency} onValueChange={(v) => {
                  const cur = v || 'USD'
                  setFormCurrency(cur)
                  if (cur === 'CNY') setFormRate('1')
                  else if (cur === 'USD') setFormRate('6.9')
                }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CNY">人民币 CNY</SelectItem>
                    <SelectItem value="USD">美元 USD</SelectItem>
                    <SelectItem value="EUR">欧元 EUR</SelectItem>
                    <SelectItem value="GBP">英镑 GBP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{formCurrency === 'CNY' ? '汇率（人民币无需填）' : '汇率'}</Label>
                <Input type="number" step="0.01" value={formRate} onChange={e => setFormRate(e.target.value)} disabled={formCurrency === 'CNY'} />
              </div>
            </div>
            {/* 额外明细行（同一供应商多个品目）；多订单分摊不支持品目拆行 */}
            {!(entryMode === 'shared' && !editItem) && extraLines.map((line, idx) => (
              <div key={idx} className="bg-muted/30 p-3 rounded space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">品目 {idx + 2}</span>
                  <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0 text-red-400 hover:text-red-600" onClick={() => setExtraLines(extraLines.filter((_, i) => i !== idx))}>×</Button>
                </div>
                <div className="space-y-1">
                  <Input placeholder="品名（如：天地盖、腰卡、挂衣袋）" value={line.desc} onChange={e => { const n = [...extraLines]; n[idx] = { ...n[idx], desc: e.target.value }; setExtraLines(n) }} className="text-sm h-8" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px]">颜色</Label>
                    <Input placeholder="如：黑色" value={line.color} onChange={e => { const n = [...extraLines]; n[idx] = { ...n[idx], color: e.target.value }; setExtraLines(n) }} className="text-xs h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">匹数</Label>
                    <Input type="number" step="0.01" placeholder="0" value={line.roll} onChange={e => { const n = [...extraLines]; n[idx] = { ...n[idx], roll: e.target.value }; setExtraLines(n) }} className="text-xs h-8" />
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px]">数量</Label>
                    <Input type="number" step="1" placeholder="0" value={line.qty} onChange={e => {
                      const n = [...extraLines]
                      n[idx] = { ...n[idx], qty: e.target.value }
                      if (e.target.value && line.unitPrice) n[idx].amount = (Number(e.target.value) * Number(line.unitPrice)).toFixed(2)
                      setExtraLines(n)
                    }} className="text-xs h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">单位</Label>
                    <Select value={line.unit || '件'} onValueChange={v => { const n = [...extraLines]; n[idx] = { ...n[idx], unit: v || '件' }; setExtraLines(n) }}>
                      <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{unitOptionsWith(line.unit).map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px]">单价</Label>
                    <Input type="number" step="0.01" placeholder="0.00" value={line.unitPrice} onChange={e => {
                      const n = [...extraLines]
                      n[idx] = { ...n[idx], unitPrice: e.target.value }
                      if (e.target.value && line.qty) n[idx].amount = (Number(line.qty) * Number(e.target.value)).toFixed(2)
                      setExtraLines(n)
                    }} className="text-xs h-8" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-semibold">金额</Label>
                    <Input type="number" step="0.01" placeholder="0.00" value={line.amount} onChange={e => { const n = [...extraLines]; n[idx] = { ...n[idx], amount: e.target.value }; setExtraLines(n) }} className="text-xs h-8 border-primary/30" />
                  </div>
                </div>
              </div>
            ))}
            {!(entryMode === 'shared' && !editItem) && (
            <Button type="button" size="sm" variant="outline" className="w-full text-xs h-7" onClick={() => setExtraLines([...extraLines, { desc: '', color: '', roll: '', qty: '', unit: '件', unitPrice: '', amount: '' }])}>
              + 添加更多品目（同一供应商）
            </Button>
            )}
            <div className="space-y-2">
              <Label>备注（可选）</Label>
              <Textarea placeholder="例：拉链、面料尾款、染色费；或其他说明" value={formDesc} onChange={e => setFormDesc(e.target.value)} rows={2} />
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="formPaid" checked={formPaid} onChange={e => setFormPaid(e.target.checked)} className="rounded" />
              <Label htmlFor="formPaid" className="text-sm cursor-pointer">已付款</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>取消</Button>
            <Button onClick={handleSaveWithValidation} disabled={saving}>
              {saving ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />保存中...</> : '确认录入'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 防错确认弹窗 */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader><DialogTitle>⚠️ 请确认以下提醒</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            {validationWarnings.filter(w => w.level === 'warning').map((w, i) => (
              <div key={i} className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <span className="text-amber-600 text-lg shrink-0">⚠</span>
                <div>
                  <p className="text-sm font-medium text-amber-800">{w.message}</p>
                  {w.suggestion && <p className="text-xs text-amber-600 mt-1">建议值: {w.suggestion}</p>}
                </div>
              </div>
            ))}
            {validationWarnings.filter(w => w.level === 'info').map((w, i) => (
              <div key={`info-${i}`} className="flex items-start gap-2 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                <span className="text-blue-500 shrink-0">ℹ</span>
                <p className="text-xs text-blue-700">{w.message}</p>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirm(false)}>返回修改</Button>
            <Button onClick={handleSave}>我确认无误，继续保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
