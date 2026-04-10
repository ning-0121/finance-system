'use client'

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Upload, FileSpreadsheet, CheckCircle, AlertTriangle, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { parseImportedExcel } from '@/lib/excel'
import { detectFileType, FILE_TYPE_LABELS, FILE_TYPE_TO_COST_TYPE, type ImportFileType } from '@/lib/excel/detect-file-type'
import { validateRows, COST_IMPORT_RULES, parseNumber, roundAmount, type ValidationError } from '@/lib/excel/validators'
import { createClient } from '@/lib/supabase/client'
import type { CostType } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  onSuccess?: (count: number) => void
}

type Step = 'upload' | 'preview' | 'importing' | 'result'

export function ExcelImportDialog({ open, onClose, onSuccess }: Props) {
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [fileType, setFileType] = useState<ImportFileType>('general_cost')
  const [confidence, setConfidence] = useState(0)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [headers, setHeaders] = useState<string[]>([])
  const [errors, setErrors] = useState<ValidationError[]>([])
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ success: number; failed: number }>({ success: 0, failed: 0 })

  // 列映射：Excel列名 → 系统字段
  const [descriptionCol, setDescriptionCol] = useState('')
  const [amountCol, setAmountCol] = useState('')
  const [currencyCol, setCurrencyCol] = useState('')
  const [dateCol, setDateCol] = useState('')

  const reset = () => {
    setStep('upload')
    setFileName('')
    setRows([])
    setHeaders([])
    setErrors([])
    setResult({ success: 0, failed: 0 })
    setDescriptionCol('')
    setAmountCol('')
    setCurrencyCol('')
    setDateCol('')
  }

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.name.match(/\.(xlsx|xls|csv)$/i)) {
      toast.error('请上传 .xlsx, .xls 或 .csv 文件')
      return
    }

    try {
      setFileName(file.name)
      const parsed = await parseImportedExcel(file)
      if (parsed.length === 0) {
        toast.error('文件为空，没有找到数据行')
        return
      }

      const cols = Object.keys(parsed[0])
      setHeaders(cols)
      setRows(parsed)

      // 智能检测文件类型
      const detection = detectFileType(cols)
      setFileType(detection.type)
      setConfidence(detection.confidence)

      // 智能猜测列映射
      autoMapColumns(cols)

      setStep('preview')
    } catch {
      toast.error('文件解析失败，请检查文件格式')
    }
  }, [])

  const autoMapColumns = (cols: string[]) => {
    const lower = cols.map(c => c.toLowerCase())

    // 描述列
    const descIdx = lower.findIndex(c =>
      c.includes('描述') || c.includes('说明') || c.includes('品名') || c.includes('description') || c.includes('名称') || c.includes('摘要')
    )
    if (descIdx >= 0) setDescriptionCol(cols[descIdx])

    // 金额列
    const amtIdx = lower.findIndex(c =>
      c.includes('金额') || c.includes('amount') || c.includes('总价') || c.includes('合计') || c.includes('费用') || c.includes('单价')
    )
    if (amtIdx >= 0) setAmountCol(cols[amtIdx])

    // 币种列
    const curIdx = lower.findIndex(c =>
      c.includes('币种') || c.includes('currency') || c.includes('货币')
    )
    if (curIdx >= 0) setCurrencyCol(cols[curIdx])

    // 日期列
    const dateIdx = lower.findIndex(c =>
      c.includes('日期') || c.includes('date') || c.includes('时间')
    )
    if (dateIdx >= 0) setDateCol(cols[dateIdx])
  }

  const handleValidate = () => {
    if (!descriptionCol || !amountCol) {
      toast.error('请至少映射"描述"和"金额"列')
      return
    }

    // 将映射后的数据做验证
    const mapped = rows.map(row => ({
      description: row[descriptionCol],
      amount: row[amountCol],
      currency: currencyCol ? row[currencyCol] : 'USD',
    }))

    const validationErrors = validateRows(mapped, COST_IMPORT_RULES)
    setErrors(validationErrors)

    if (validationErrors.length > 0) {
      toast.warning(`发现 ${validationErrors.length} 个问题，请检查标红行`)
    }
  }

  const handleImport = async () => {
    if (!descriptionCol || !amountCol) return

    setImporting(true)
    setStep('importing')

    let successCount = 0
    let failCount = 0

    const supabase = createClient()
    const costType = FILE_TYPE_TO_COST_TYPE[fileType] as CostType
    const errorRows = new Set(errors.map(e => e.row))

    // 去重检测：获取已有记录的描述+金额组合
    const { data: existing } = await supabase
      .from('cost_items')
      .select('description, amount')
      .eq('source_module', 'excel_import')
    const existingSet = new Set((existing || []).map(e => `${e.description}|${e.amount}`))
    let skipDuplicates = 0

    for (let i = 0; i < rows.length; i++) {
      if (errorRows.has(i + 2)) {
        failCount++
        continue
      }

      const row = rows[i]
      const amount = roundAmount(parseNumber(row[amountCol]))

      if (isNaN(amount) || amount <= 0) {
        failCount++
        continue
      }

      const desc = String(row[descriptionCol] || fileName)

      // 去重：跳过已导入的相同描述+金额
      if (existingSet.has(`${desc}|${amount}`)) {
        skipDuplicates++
        continue
      }

      try {
        const { error } = await supabase.from('cost_items').insert({
          cost_type: costType,
          description: desc,
          amount,
          currency: currencyCol ? String(row[currencyCol] || 'USD').toUpperCase() : 'USD',
          exchange_rate: 1,
          source_module: 'excel_import',
          source_id: fileName,
          created_by: '00000000-0000-0000-0000-000000000000',
        })

        if (error) failCount++
        else { successCount++; existingSet.add(`${desc}|${amount}`) }
      } catch {
        failCount++
      }
    }

    setResult({ success: successCount, failed: failCount + skipDuplicates })
    setImporting(false)
    setStep('result')

    if (successCount > 0 && onSuccess) {
      onSuccess(successCount)
    }
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
            {step === 'upload' && '批量导入 Excel'}
            {step === 'preview' && '数据预览与列映射'}
            {step === 'importing' && '正在导入...'}
            {step === 'result' && '导入完成'}
          </DialogTitle>
        </DialogHeader>

        {/* Step 1: Upload */}
        {step === 'upload' && (
          <div
            className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = '.xlsx,.xls,.csv'
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0]
                if (file) handleFileSelect(file)
              }
              input.click()
            }}
          >
            <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">拖放文件到此处 或 点击选择</p>
            <p className="text-sm text-muted-foreground mt-2">支持 .xlsx, .xls, .csv 格式</p>
            <p className="text-xs text-muted-foreground mt-1">
              供应商对账单、采购单、PI、CI、装箱单、运费单、送货码单等
            </p>
          </div>
        )}

        {/* Step 2: Preview */}
        {step === 'preview' && (
          <div className="space-y-4">
            {/* File info */}
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
              <FileSpreadsheet className="h-5 w-5 text-green-600" />
              <div className="flex-1">
                <p className="text-sm font-medium">{fileName}</p>
                <p className="text-xs text-muted-foreground">{rows.length} 行数据</p>
              </div>
              <Badge variant={confidence > 0.5 ? 'default' : 'secondary'}>
                {FILE_TYPE_LABELS[fileType]} ({Math.round(confidence * 100)}%)
              </Badge>
              <Select value={fileType} onValueChange={(v) => setFileType((v || fileType) as ImportFileType)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(FILE_TYPE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Column mapping */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="space-y-1">
                <p className="text-xs font-medium text-red-600">描述列 *</p>
                <Select value={descriptionCol} onValueChange={(v) => setDescriptionCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="选择列" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-red-600">金额列 *</p>
                <Select value={amountCol} onValueChange={(v) => setAmountCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="选择列" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">币种列</p>
                <Select value={currencyCol} onValueChange={(v) => setCurrencyCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="默认USD" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium">日期列</p>
                <Select value={dateCol} onValueChange={(v) => setDateCol(v || '')}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="可选" /></SelectTrigger>
                  <SelectContent>{headers.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            {errors.length > 0 && (
              <div className="flex items-center gap-2 p-2 bg-amber-50 rounded-lg text-amber-700 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{errors.length} 个验证问题（标红行将被跳过）</span>
              </div>
            )}

            {/* Data preview table */}
            <div className="border rounded-lg overflow-x-auto max-h-[300px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    {headers.slice(0, 8).map(h => (
                      <TableHead key={h} className={`text-xs ${h === descriptionCol || h === amountCol ? 'bg-primary/5 font-bold' : ''}`}>
                        {h}
                        {h === descriptionCol && <span className="text-red-500 ml-0.5">*</span>}
                        {h === amountCol && <span className="text-red-500 ml-0.5">*</span>}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.slice(0, 20).map((row, i) => {
                    const hasError = errors.some(e => e.row === i + 2)
                    return (
                      <TableRow key={i} className={hasError ? 'bg-red-50' : ''}>
                        <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                        {headers.slice(0, 8).map(h => (
                          <TableCell key={h} className="text-xs max-w-[150px] truncate">
                            {String(row[h] ?? '')}
                          </TableCell>
                        ))}
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
            {rows.length > 20 && (
              <p className="text-xs text-muted-foreground text-center">显示前 20 行，共 {rows.length} 行</p>
            )}
          </div>
        )}

        {/* Step 3: Importing */}
        {step === 'importing' && (
          <div className="text-center py-12">
            <Loader2 className="h-12 w-12 mx-auto mb-4 animate-spin text-primary" />
            <p className="text-lg font-medium">正在导入数据...</p>
            <p className="text-sm text-muted-foreground mt-2">请勿关闭此窗口</p>
          </div>
        )}

        {/* Step 4: Result */}
        {step === 'result' && (
          <div className="text-center py-8 space-y-4">
            <CheckCircle className="h-16 w-16 mx-auto text-green-500" />
            <p className="text-lg font-medium">导入完成</p>
            <div className="flex justify-center gap-8">
              <div>
                <p className="text-3xl font-bold text-green-600">{result.success}</p>
                <p className="text-sm text-muted-foreground">成功</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-red-600">{result.failed}</p>
                <p className="text-sm text-muted-foreground">失败</p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={() => { handleValidate() }}>验证数据</Button>
              <Button onClick={handleImport} disabled={!descriptionCol || !amountCol}>
                确认导入 ({rows.length - new Set(errors.map(e => e.row)).size} 行)
              </Button>
            </>
          )}
          {step === 'result' && (
            <Button onClick={() => { reset(); onClose() }}>完成</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
