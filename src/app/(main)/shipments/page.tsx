'use client'

// 出运档案(功能2):每一票货(=一张提单)一站式调出 提单 / CI / 客户PO / 决算单。
// 一单可多票、多单可合一票(多对多);数据由节拍器 shipment.recorded 推送。只读聚合。

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Ship, Search, FileText, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { openAttachment } from '@/lib/supabase/storage'

interface ShipmentRow {
  id: string
  bl_no: string | null
  ci_no: string | null
  shipping_port: string | null
  destination_port: string | null
  etd: string | null
  carton_count: number | null
  status: string
  created_at: string
}
interface LinkRow {
  shipment_id: string
  qimo_order_id: string | null
  order_no: string | null
  internal_order_no: string | null
  budget_order_id: string | null
}
interface DocRow { id: string; file_name: string; doc_hint: string | null; file_url: string | null; related_shipment_id?: string | null; related_qimo_order_id?: string | null; matched_order_id?: string | null; doc_category?: string | null }

const HINT_LABEL: Record<string, { label: string; cls: string }> = {
  bl: { label: '提单', cls: 'bg-indigo-100 text-indigo-700' },
  ci: { label: 'CI', cls: 'bg-teal-100 text-teal-700' },
  po: { label: '客户PO', cls: 'bg-blue-100 text-blue-700' },
}
const ST_LABEL: Record<string, string> = { shipped: '已出运', arrived: '已到港', closed: '已结', cancelled: '已取消' }
const fmtDate = (v: string | null) => (v ? String(v).slice(0, 10) : '—')

export default function ShipmentsPage() {
  const [loading, setLoading] = useState(true)
  const [ships, setShips] = useState<ShipmentRow[]>([])
  const [links, setLinks] = useState<LinkRow[]>([])
  const [shipDocs, setShipDocs] = useState<DocRow[]>([])       // 提单/CI(挂票)
  const [poDocs, setPoDocs] = useState<DocRow[]>([])           // 客户PO(挂订单)
  const [settleMap, setSettleMap] = useState<Record<string, string>>({})  // budget_order_id → 决算 status
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const sb = createClient()
      const { data: s } = await sb.from('shipments')
        .select('id, bl_no, ci_no, shipping_port, destination_port, etd, carton_count, status, created_at')
        .is('deleted_at', null).order('created_at', { ascending: false }).limit(200)
      const shipRows = (s as ShipmentRow[]) || []
      setShips(shipRows)
      if (!shipRows.length) { setLinks([]); setShipDocs([]); setPoDocs([]); setSettleMap({}); return }
      const shipIds = shipRows.map(r => r.id)

      const [{ data: lk }, { data: sd }] = await Promise.all([
        sb.from('shipment_orders').select('shipment_id, qimo_order_id, order_no, internal_order_no, budget_order_id').in('shipment_id', shipIds),
        sb.from('uploaded_documents').select('id, file_name, doc_hint, file_url, related_shipment_id').in('related_shipment_id', shipIds),
      ])
      const linkRows = (lk as LinkRow[]) || []
      setLinks(linkRows)
      setShipDocs((sd as DocRow[]) || [])

      const boIds = [...new Set(linkRows.map(l => l.budget_order_id).filter(Boolean))] as string[]
      const qimoIds = [...new Set(linkRows.map(l => l.qimo_order_id).filter(Boolean))] as string[]
      const keys = [...new Set([...qimoIds, ...boIds])]
      const [{ data: st }, { data: pd }, { data: pd2 }] = await Promise.all([
        boIds.length ? sb.from('order_settlements').select('budget_order_id, status').in('budget_order_id', boIds) : Promise.resolve({ data: [] }),
        qimoIds.length ? sb.from('uploaded_documents').select('id, file_name, doc_hint, file_url, related_qimo_order_id').in('related_qimo_order_id', qimoIds).eq('doc_hint', 'po') : Promise.resolve({ data: [] }),
        // 历史客户PO(财务上传/AI识别流)挂在 matched_order_id、无 doc_hint —— union 补上,否则恒显示"无PO附件"(审计 P2)
        keys.length ? sb.from('uploaded_documents').select('id, file_name, doc_hint, file_url, related_qimo_order_id, matched_order_id, doc_category').in('matched_order_id', keys) : Promise.resolve({ data: [] }),
      ])
      const sm: Record<string, string> = {}
      for (const r of (st as { budget_order_id: string; status: string }[] | null) || []) sm[r.budget_order_id] = r.status
      setSettleMap(sm)
      const histPo = ((pd2 as DocRow[]) || []).filter(d => d.doc_hint === 'po' || d.doc_category === 'customer_po')
      const merged = new Map<string, DocRow>()
      for (const d of [...(((pd as DocRow[]) || [])), ...histPo]) merged.set(d.id, d)
      setPoDocs([...merged.values()])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const kw = q.trim().toLowerCase()
  const filtered = !kw ? ships : ships.filter(s => {
    const ords = links.filter(l => l.shipment_id === s.id)
    return [s.bl_no, s.ci_no, ...ords.map(o => o.order_no), ...ords.map(o => o.internal_order_no)]
      .some(v => (v || '').toLowerCase().includes(kw))
  })

  return (
    <div className="flex flex-col h-full">
      <Header title="出运档案" subtitle="每一票货(=一张提单)一站式调出:提单 / CI / 客户PO / 决算单" />
      <div className="flex-1 p-4 md:p-6 space-y-4 overflow-y-auto">
        <div className="flex gap-2 max-w-lg">
          <Input placeholder="搜提单号 / CI号 / 订单号 / 款号" value={q} onChange={e => setQ(e.target.value)} />
          <Button variant="outline" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Ship className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">{ships.length === 0 ? '暂无出运档案——待节拍器出运时推送(shipment.recorded)' : '没有匹配的票'}</p>
          </div>
        ) : filtered.map(s => {
          const ords = links.filter(l => l.shipment_id === s.id)
          const docs = shipDocs.filter(d => d.related_shipment_id === s.id)
          const bls = docs.filter(d => (d.doc_hint || 'bl') === 'bl')
          const cis = docs.filter(d => d.doc_hint === 'ci')
          const isOpen = open[s.id] !== false   // 默认展开
          return (
            <Card key={s.id}>
              <button className="w-full text-left" onClick={() => setOpen(m => ({ ...m, [s.id]: !isOpen }))}>
                <CardContent className="p-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {isOpen ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                    <Ship className="h-4 w-4 text-indigo-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="font-semibold text-sm truncate">
                        提单 {s.bl_no || '—'}{s.ci_no ? ` · CI ${s.ci_no}` : ''}
                        <Badge variant="secondary" className="ml-2 text-[10px]">{ST_LABEL[s.status] || s.status}</Badge>
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {[s.shipping_port, s.destination_port].filter(Boolean).join(' → ') || '港口未填'} · ETD {fmtDate(s.etd)}{s.carton_count ? ` · ${s.carton_count} 箱` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0 text-[11px] text-muted-foreground">
                    {ords.length} 个订单 · {docs.length} 份单据
                  </div>
                </CardContent>
              </button>
              {isOpen && (
                <CardContent className="pt-0 px-4 pb-4 space-y-3">
                  {/* 提单 / CI 文件 */}
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold text-muted-foreground mb-2">票面单据</p>
                    {docs.length === 0 ? (
                      <p className="text-xs text-muted-foreground">暂无文件(等节拍器推送提单/CI)</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {[...bls, ...cis, ...docs.filter(d => !['bl', 'ci'].includes(d.doc_hint || 'bl'))].map(d => {
                          const h = HINT_LABEL[d.doc_hint || 'bl'] || { label: d.doc_hint || '文件', cls: 'bg-muted text-muted-foreground' }
                          return (
                            <button key={d.id} onClick={() => openAttachment(d.file_url)}
                              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted/60">
                              <Badge variant="secondary" className={`${h.cls} text-[10px] px-1`}>{h.label}</Badge>
                              <FileText className="h-3 w-3" /><span className="max-w-[220px] truncate">{d.file_name}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  {/* 关联订单:客户PO + 决算 */}
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-semibold text-muted-foreground mb-2">关联订单({ords.length})· 客户PO / 决算单</p>
                    {ords.length === 0 ? (
                      <p className="text-xs text-muted-foreground">未关联订单</p>
                    ) : (
                      <div className="space-y-1.5">
                        {ords.map(o => {
                          const pos = poDocs.filter(d =>
                            (d.related_qimo_order_id && d.related_qimo_order_id === o.qimo_order_id) ||
                            (d.matched_order_id && (d.matched_order_id === o.qimo_order_id || (o.budget_order_id && d.matched_order_id === o.budget_order_id))))
                          const settle = o.budget_order_id ? settleMap[o.budget_order_id] : undefined
                          return (
                            <div key={`${o.shipment_id}-${o.qimo_order_id || o.order_no}`} className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-medium">{o.internal_order_no || o.order_no || '—'}</span>
                              {o.order_no && o.order_no !== o.internal_order_no && <span className="text-muted-foreground">{o.order_no}</span>}
                              {pos.map(p => (
                                <button key={p.id} onClick={() => openAttachment(p.file_url)}
                                  className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-muted/60">
                                  <Badge variant="secondary" className="bg-blue-100 text-blue-700 text-[10px] px-1">客户PO</Badge>
                                  <span className="max-w-[160px] truncate">{p.file_name}</span>
                                </button>
                              ))}
                              {pos.length === 0 && <span className="text-muted-foreground">(无PO附件)</span>}
                              {o.budget_order_id ? (
                                <>
                                  <a href={`/orders/${o.budget_order_id}/settlement`} target="_blank" rel="noreferrer"
                                    className="inline-flex items-center gap-0.5 text-primary hover:underline">
                                    决算单{settle ? `(${settle === 'confirmed' ? '已确认' : settle === 'locked' ? '已锁' : '草稿'})` : '(未生成)'}
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                  <a href={`/orders/${o.budget_order_id}`} target="_blank" rel="noreferrer"
                                    className="inline-flex items-center gap-0.5 text-primary hover:underline">订单<ExternalLink className="h-3 w-3" /></a>
                                </>
                              ) : <span className="text-amber-600">未匹配到财务订单</span>}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
