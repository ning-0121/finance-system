'use client'

// ============================================================
// Phase A-1: 字段来源徽章
// 在关键字段旁显示一个小图标，hover/click 显示来源详情
// ============================================================

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Scroll, Loader2, AlertCircle } from 'lucide-react'
import type { LineageRow, SotSourceType } from '@/lib/sot/source-types'

interface Props {
  table: string
  rowId: string
  field: string
  /** 可选：直接传入 lineage，避免重复请求 */
  initialLineage?: LineageRow | null
  className?: string
}

const SOURCE_LABELS: Record<SotSourceType, string> = {
  customer_po:        '客户PO',
  quotation:          '报价单',
  logistics_invoice:  '物流账单',
  bank_statement:     '银行回单',
  supplier_invoice:   '供应商发票',
  packing_list:       '装箱单',
  inbound_record:     '入库单',
  manual_entry:       '人工录入',
  derived:            '系统派生',
  external_system:    '外部同步',
}

const SOURCE_COLORS: Record<SotSourceType, string> = {
  customer_po:        'text-emerald-700 bg-emerald-50 border-emerald-200',
  quotation:          'text-emerald-700 bg-emerald-50 border-emerald-200',
  logistics_invoice:  'text-emerald-700 bg-emerald-50 border-emerald-200',
  bank_statement:     'text-emerald-700 bg-emerald-50 border-emerald-200',
  supplier_invoice:   'text-emerald-700 bg-emerald-50 border-emerald-200',
  packing_list:       'text-emerald-700 bg-emerald-50 border-emerald-200',
  inbound_record:     'text-emerald-700 bg-emerald-50 border-emerald-200',
  manual_entry:       'text-amber-700 bg-amber-50 border-amber-200',
  derived:            'text-blue-700 bg-blue-50 border-blue-200',
  external_system:    'text-purple-700 bg-purple-50 border-purple-200',
}

function fmtConfidence(c: number): string {
  if (c >= 0.95) return '高'
  if (c >= 0.80) return '中'
  return '低'
}

function fmtDate(s: string | null): string {
  if (!s) return '—'
  try { return new Date(s).toLocaleString('zh-CN') } catch { return s }
}

export function FieldSourceBadge({ table, rowId, field, initialLineage, className }: Props) {
  const [lineage, setLineage] = useState<LineageRow | null | undefined>(initialLineage)
  const [loading, setLoading] = useState(false)
  const [errored, setErrored] = useState(false)

  // 第一次打开 popover 时拉数据
  const handleOpen = async (open: boolean) => {
    if (!open) return
    if (lineage !== undefined) return
    setLoading(true)
    setErrored(false)
    try {
      const params = new URLSearchParams({ table, row_id: rowId, field })
      const res = await fetch(`/api/sot/lineage?${params}`)
      const j = await res.json()
      if (!res.ok) { setErrored(true); setLineage(null); return }
      setLineage((j.lineage ?? null) as LineageRow | null)
    } catch {
      setErrored(true)
      setLineage(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Popover onOpenChange={handleOpen}>
      <PopoverTrigger
        className={`inline-flex items-center justify-center h-4 w-4 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 transition ${className || ''}`}
        aria-label="查看字段来源"
        title="查看字段来源"
      >
        <Scroll className="h-3 w-3" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            读取来源…
          </div>
        )}

        {!loading && errored && (
          <div className="flex items-center gap-2 text-xs text-amber-600 py-2">
            <AlertCircle className="h-3 w-3" />
            读取来源失败
          </div>
        )}

        {!loading && !errored && lineage === null && (
          <div className="text-xs text-muted-foreground py-1">
            <p className="font-medium text-foreground mb-1">字段：{field}</p>
            <p>暂无血缘记录。该字段可能在 SoT 接入前已写入。</p>
          </div>
        )}

        {!loading && !errored && lineage && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">字段来源</p>
              <Badge variant="outline" className={`text-[10px] ${SOURCE_COLORS[lineage.source_type]}`}>
                {SOURCE_LABELS[lineage.source_type] || lineage.source_type}
              </Badge>
            </div>

            <dl className="text-xs space-y-1.5">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground shrink-0">来源实体</dt>
                <dd className="text-right font-medium truncate">{lineage.source_entity || '—'}</dd>
              </div>
              {lineage.source_field && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground shrink-0">来源字段</dt>
                  <dd className="text-right font-mono text-[11px]">{lineage.source_field}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground shrink-0">置信度</dt>
                <dd className="text-right font-medium">
                  {fmtConfidence(lineage.confidence)} ({(lineage.confidence * 100).toFixed(0)}%)
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground shrink-0">最近验证</dt>
                <dd className="text-right">{fmtDate(lineage.last_verified_at)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground shrink-0">写入时间</dt>
                <dd className="text-right">{fmtDate(lineage.created_at)}</dd>
              </div>
              {lineage.allow_manual_override === false && (
                <div className="flex justify-between gap-2 pt-1 border-t">
                  <dt className="text-amber-700 font-medium">不允许人工修改</dt>
                </div>
              )}
              {lineage.override_reason && (
                <div className="pt-1 border-t">
                  <dt className="text-muted-foreground">override 原因</dt>
                  <dd className="mt-0.5">{lineage.override_reason}</dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
