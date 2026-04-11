'use client'

import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Upload, FileSpreadsheet, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { detectFileType, FILE_TYPE_LABELS, FILE_TYPE_TO_COST_TYPE, type ImportFileType } from '@/lib/excel/detect-file-type'
import { parseNumber, roundAmount } from '@/lib/excel/validators'
import { createClient } from '@/lib/supabase/client'
import type { CostType } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  onSuccess?: (count: number) => void
}

type Step = 'upload' | 'preview' | 'importing' | 'result'

// 费用类型选项
const COST_TYPE_OPTIONS: { value: CostType; label: string }[] = [
  { value: 'freight', label: '运费' },
  { value: 'procurement', label: '采购成本' },
  { value: 'commission', label: '佣金' },
  { value: 'customs', label: '报关费' },
  { value: 'other', label: '其他' },
]

export function ExcelImportDialog({ open, onClose, onSuccess }: Props) {
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [fileType, setFileType] = useState<ImportFileType>('general_cost')
  const [confidence, setConfidence] = useState(0)
  const [allRows, setAllRows] = useState<Record<string, unknown>[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ success: number; failed: number; skipped: number }>({ success: 0, failed: 0, skipped: 0 })

  // 跳过前N行
  const [skipRows, setSkipRows] = useState(0)

  // 列映射
  const [descriptionCol, setDescriptionCol] = useState('')
  const [amountCol, setAmountCol] = useState('')
  const [orderNoCol, setOrderNoCol] = useState('')
  const [supplierCol, setSupplierCol] = useState('')
  const [currencyCol, setCurrencyCol] = useState('')
  const [dateCol, setDateCol] = useState('')

  // 费用类型
  const [costType, setCostType] = useState<CostType>('freight')

  // 订单列表（用于关联）
  const [orderOptions, setOrderOptions] = useState<{ id: string; order_no: string }[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState('')

  // 加载订单列表
  useEffect(() => {
    if (!open) return
    async function loadOrders() {
      const supabase = createClient()
      const { data } = await supabase.from('budget_orders').select('id, order_no').order('order_no', { ascending: false }).limit(200)
      if (data) setOrderOptions(data)
    }
    loadOrders()
  }, [open])

  const reset = () => {
    setStep('upload'); setFileName(''); setAllRows([]); setRows([]); setHeaders([])
    setResult({ success: 0, failed: 0, skipped: 0 }); setSkipRows(0)
    setDescriptionCol(''); setAmountCol(''); setOrderNoCol(''); setSupplierCol('')
    setCurrencyCol(''); setDateCol(''); setSelectedOrderId('')
  }

  // 当skipRows变化时重新解析
  useEffect(() => {
    if (allRows.length === 0) return
    const effective = allRows.slice(skipRows)
    if (effective.length === 0) return
    const cols = Object.keys(effective[0])
    setHeaders(cols)
    setRows(effective)
    autoMapColumns(cols)
  }, [skipRows, allRows])

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      toast.error('请上传 .xlsx, .xls 或 .csv 文件')
      return
    }

    try {
      setFileName(file.name)
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellFormula: false, cellDates: true, cellNF: true })
      const ws = wb.Sheets[wb.SheetNames[0]]

      // 用raw模式获取所有行（包括表头行）
      const rawRows = XLSX.utils.sheet_to_json(ws, { defval: '', blankrows: false, raw: false }) as Record<string, unknown>[]

      if (rawRows.length === 0) {
        toast.error('文件为空')
        return
      }

      setAllRows(rawRows)

      // 检测是否需要跳过行（前几行是公司信息等）
      const firstRowValues = Object.values(rawRows[0]).map(String)
      const hasDataInFirstRow = firstRowValues.some(v => {
        const n = parseNumber(v)
        return !isNaN(n) && n > 0
      })

      // 如果第一行没有数字，可能是表头/公司信息，尝试自动检测数据开始行
      if (!hasDataInFirstRow && rawRows.length > 3) {
        for (let i = 1; i < Math.min(15, rawRows.length); i++) {
          const vals = Object.values(rawRows[i]).map(String)
          const hasNum = vals.some(v => { const n = parseNumber(v); return !isNaN(n) && n > 0 })
          if (hasNum) {
            setSkipRows(i)
            break
          }
        }
      } else {
        setSkipRows(0)
      }

      // 自动识别费用类型
      const fileNameLower = file.name.toLowerCase()
      if (fileNameLower.includes('运费') || fileNameLower.includes('freight') || fileNameLower.includes('物流') || fileNameLower.includes('货代')) {
        setCostType('freight')
      } else if (fileNameLower.includes('采购') || fileNameLower.includes('面料') || fileNameLower.includes('辅料')) {
        setCostType('procurement')
      } else if (fileNameLower.includes('佣金') || fileNameLower.includes('commission')) {
        setCostType('commission')
      } else if (fileNameLower.includes('报关') || fileNameLower.includes('customs')) {
        setCostType('customs')
      }

      const cols = Object.keys(rawRows[0])
      const detection = detectFileType(cols)
      setFileType(detection.type)
      setConfidence(detection.confidence)

      setStep('preview')
    } catch {
      toast.error('文件解析失败，请检查文件格式')
    }
  }, [])

  const autoMapColumns = (cols: string[]) => {
    const lower = cols.map(c => c.toLowerCase())

    const descIdx = lower.findIndex(c => c.includes('描述') || c.includes('说明') || c.includes('品名') || c.includes('description') || c.includes('名称') || c.includes('摘要') || c.includes('费用项'))
    if (descIdx >= 0) setDescriptionCol(cols[descIdx])

    const amtIdx = lower.findIndex(c => c.includes('金额') || c.includes('amount') || c.includes('总价') || c.includes('合计') || c.includes('费用') || c.includes('rmb') || c.includes('usd'))
    if (amtIdx >= 0) setAmountCol(cols[amtIdx])

    const orderIdx = lower.findIndex(c => c.includes('订单') || c.includes('order') || c.includes('单号') || c.includes('po') || c.includes('柜号'))
    if (orderIdx >= 0) setOrderNoCol(cols[orderIdx])

    const supplierIdx = lower.findIndex(c => c.includes('供应商') || c.includes('vendor') || c.includes('supplier') || c.includes('公司') || c.includes('工厂') || c.includes('货代'))
    if (supplierIdx >= 0) setSupplierCol(cols[supplierIdx])

    const curIdx = lower.findIndex(c => c.includes('币种') || c.includes('currency') || c.includes('货币'))
    if (curIdx >= 0) setCurrencyCol(cols[curIdx])

    const dateIdx = lower.findIndex(c => c.includes('日期') || c.includes('date') || c.includes('时间'))
    if (dateIdx >= 0) setDateCol(cols[dateIdx])
  }

  const handleImport = async () => {
    if (!amountCol) { toast.error('请至少映射"金额列"'); return }

    setImporting(true)
    setStep('importing')

    let successCount = 0, failCount = 0, skipCount = 0
    const supabase = createClient()

    // 获取用户ID
    const { data: { user } } = await supabase.auth.getUser()
    const userId = user?.id || '00000000-0000-0000-0000-000000000000'

    // 去重检测
    const { data: existing } = await supabase.from('cost_items').select('description, amount').eq('source_module', 'excel_import')
    const existingSet = new Set((existing || []).map(e => `${e.description}|${e.amount}`))

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const amount = roundAmount(parseNumber(row[amountCol]))

      if (isNaN(amount) || amount <= 0) { failCount++; continue }

      const desc = descriptionCol ? String(row[descriptionCol] || '') : ''
      const supplier = supplierCol ? String(row[supplierCol] || '') : ''
      const fullDesc = [supplier, desc, !desc && !supplier ? fileName : ''].filter(Boolean).join(' - ')

      // 去重
      if (existingSet.has(`${fullDesc}|${amount}`)) { skipCount++; continue }

      // 关联订单：优先用选择的订单，其次用Excel中的订单号列匹配
      let budgetOrderId: string | null = selectedOrderId || null
      if (!budgetOrderId && orderNoCol) {
        const orderNo = String(row[orderNoCol] || '')
        if (orderNo) {
          const match = orderOptions.find(o => o.order_no.includes(orderNo) || orderNo.includes(o.order_no))
          if (match) budgetOrderId = match.id
        }
      }

      try {
        const { error } = await supabase.from('cost_items').insert({
          budget_order_id: budgetOrderId,
          cost_type: costType,
          description: fullDesc || fileName,
          amount,
          currency: currencyCol ? String(row[currencyCol] || 'CNY').toUpperCase() : 'CNY',
          exchange_rate: 1,
          source_module: 'excel_import',
          source_id: fileName,
          created_by: userId,
        })

        if (error) failCount++
        else { successCount++; existingSet.add(`${fullDesc}|${amount}`) }
      } catch { failCount++ }
    }

    setResult({ success: successCount, failed: failCount, skipped: skipCount })
    setImporting(false)
    setStep('result')

    if (successCount > 0 && onSuccess) onSuccess(successCount)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }, [handleFileSelect])

  return (
    <Dialog open={open} onOpenChange={() => { reset(); onClose() }}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 'upload' && '批量导入费用'}
            {step === 'preview' && '数据预览与列映射'}
            {step === 'importing' && '正在导入...'}
            {step === 'result' && '导入完成'}
          </DialogTitle>
        </DialogHeader>

        {/* Upload */}
        {step === 'upload' && (
          <div
            className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
            onDragOver={e => e.preventDefault()} onDrop={handleDrop}
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'; input.accept = '.xlsx,.xls,.csv'
              input.onchange = e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) handleFileSelect(f) }
              input.click()
            }}
          >
            <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">拖放文件到此处 或 点击选择</p>
            <p className="text-sm text-muted-foreground mt-2">支持 .xlsx, .xls, .csv</p>
            <p className="text-xs text-muted-foreground mt-1">货代费、供应商对账单、采购单等</p>
          </div>
        )}

        {/* Preview */}
        {step === 'preview' && (
          <div className="space-y-4">
            {/* 文件信息 */}
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg flex-wrap">
              <FileSpreadsheet className="h-5 w-5 text-green-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{fileName}</p>
                <p className="text-xs text-muted-foreground">{rows.length} 行数据{skipRows > 0 ? `（跳过前${skipRows}行表头）` : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0">跳过行:</Label>
                <Input type="number" className="h-7 w-16 text-xs" min={0} max={20} value={skipRows} onChange={e => setSkipRows(Number(e.target.value) || 0)} />
              </div>
            </div>

            {/* 费用类型 + 关联订单 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs font-medium text-red-600">费用类型 *</Label>
                <Select value={costType} onValueChange={v => setCostType((v || 'freight') as CostType)}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {COST_TYPE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">关联订单（整批归集到同一订单）</Label>
                <Select value={selectedOrderId} onValueChange={v => setSelectedOrderId(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="不指定（按Excel列匹配）" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">不指定</SelectItem>
                    {orderOptions.map(o => <SelectItem key={o.id} value={o.id}>{o.order_no}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* 列映射 — 6列 */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="space-y-1">
                <p className="text-xs font-medium text-red-600">金额列 *</p>
                <Select value={amountCol} onValueChange={v => setAmountCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="选择" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">描述列</p>
                <Select value={descriptionCol} onValueChange={v => setDescriptionCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="选择" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">供应商列</p>
                <Select value={supplierCol} onValueChange={v => setSupplierCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="选择" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">订单号列</p>
                <Select value={orderNoCol} onValueChange={v => setOrderNoCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="选择" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">币种列</p>
                <Select value={currencyCol} onValueChange={v => setCurrencyCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="默认CNY" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">日期列</p>
                <Select value={dateCol} onValueChange={v => setDateCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="可选" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            {/* 数据预览 */}
            <div className="border rounded-lg overflow-x-auto max-h-[250px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    {headers.slice(0, 8).map(h => (
                      <TableHead key={h} className={`text-xs ${h === amountCol ? 'bg-green-50 font-bold' : h === descriptionCol ? 'bg-blue-50 font-bold' : h === supplierCol ? 'bg-purple-50 font-bold' : h === orderNoCol ? 'bg-amber-50 font-bold' : ''}`}>
                        {h}
                        {h === amountCol && <span className="text-green-600 ml-0.5">¥</span>}
                        {h === orderNoCol && <span className="text-amber-600 ml-0.5">#</span>}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 15).map((row, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                      {headers.slice(0, 8).map(h => (
                        <TableCell key={h} className="text-xs max-w-[150px] truncate">{String(row[h] ?? '')}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {rows.length > 15 && <p className="text-xs text-muted-foreground text-center">显示前15行，共{rows.length}行</p>}
          </div>
        )}

        {/* Importing */}
        {step === 'importing' && (
          <div className="text-center py-12">
            <Loader2 className="h-12 w-12 mx-auto mb-4 animate-spin text-primary" />
            <p className="text-lg font-medium">正在导入...</p>
          </div>
        )}

        {/* Result */}
        {step === 'result' && (
          <div className="text-center py-8 space-y-4">
            <CheckCircle className="h-16 w-16 mx-auto text-green-500" />
            <p className="text-lg font-medium">导入完成</p>
            <div className="flex justify-center gap-6">
              <div><p className="text-3xl font-bold text-green-600">{result.success}</p><p className="text-sm text-muted-foreground">成功</p></div>
              <div><p className="text-3xl font-bold text-amber-600">{result.skipped}</p><p className="text-sm text-muted-foreground">跳过(重复)</p></div>
              <div><p className="text-3xl font-bold text-red-600">{result.failed}</p><p className="text-sm text-muted-foreground">失败</p></div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'preview' && (
            <Button onClick={handleImport} disabled={!amountCol}>
              确认导入 ({rows.length} 行 · {COST_TYPE_OPTIONS.find(o => o.value === costType)?.label})
            </Button>
          )}
          {step === 'result' && <Button onClick={() => { reset(); onClose() }}>完成</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
