'use client'

import { use, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { ArrowLeft, CheckCircle, XCircle, Loader2, AlertTriangle, Sparkles, Eye } from 'lucide-react'
import { PreExecutionReview } from '@/components/documents/PreExecutionReview'
import { toast } from 'sonner'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  DOC_CATEGORY_LABELS, FIELD_TEMPLATES, ACTION_TYPE_LABELS,
  type UploadedDocument, type DocumentAction, type DocCategory,
} from '@/lib/types/document'

export default function DocumentConfirmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [doc, setDoc] = useState<UploadedDocument | null>(null)
  const [actions, setActions] = useState<DocumentAction[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editedFields, setEditedFields] = useState<Record<string, unknown>>({})
  const [showReview, setShowReview] = useState(false)
  const [previewData, setPreviewData] = useState<Record<string, unknown> | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data: docData } = await supabase.from('uploaded_documents').select('*').eq('id', id).single()
      if (docData) {
        setDoc(docData as UploadedDocument)
        setEditedFields(docData.extracted_fields || {})
      }
      const { data: actionsData } = await supabase.from('document_actions').select('*').eq('document_id', id)
      if (actionsData) setActions(actionsData as DocumentAction[])
      setLoading(false)
    }
    load()
  }, [id])

  // Step 1: 预览执行（不执行）
  const handlePreview = async () => {
    setPreviewLoading(true)
    try {
      const res = await fetch('/api/documents/pre-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: id, confirmed_fields: editedFields }),
      })
      const data = await res.json()
      setPreviewData(data)
      setShowReview(true)
    } catch {
      toast.error('预览失败')
    }
    setPreviewLoading(false)
  }

  // Step 2: 确认执行（用户逐个accept/reject后）
  const handleExecute = async (approvedActions: string[], rejectedActions: string[]) => {
    if (!doc) return
    setSaving(true)

    // 保存字段变更
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    const original = doc.extracted_fields || {}
    for (const key of Object.keys(editedFields)) {
      if (key.startsWith('_')) continue
      if (JSON.stringify(original[key]) !== JSON.stringify(editedFields[key])) {
        changes[key] = { from: original[key], to: editedFields[key] }
      }
    }

    const supabase = createClient()
    const { error: updateErr } = await supabase.from('uploaded_documents').update({
      extracted_fields: editedFields,
      confirmation_changes: Object.keys(changes).length > 0 ? changes : null,
    }).eq('id', id)
    if (updateErr) console.error('文档字段更新失败:', updateErr.message)

    // 保存模板记忆
    const entityName = (editedFields.customer_name || editedFields.supplier_name || editedFields.payer_name) as string
    if (entityName && doc.doc_category) {
      const { error: tplErr } = await supabase.from('extraction_templates').upsert({
        template_name: `${entityName}_${doc.doc_category}`,
        entity_name: entityName,
        entity_type: editedFields.customer_name ? 'customer' : 'supplier',
        doc_category: doc.doc_category,
        column_mapping: editedFields,
        last_used_at: new Date().toISOString(),
      }, { onConflict: 'template_name' })
      if (tplErr) console.error('模板保存失败:', tplErr.message)
    }

    // 执行（只传accepted的动作）
    try {
      const execRes = await fetch('/api/documents/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_id: id,
          confirmed_fields: editedFields,
          confirmed_by: 'current_user',
          approved_actions: approvedActions,
          rejected_actions: rejectedActions,
        }),
      })
      const execResult = await execRes.json()
      if (execResult.error) {
        toast.error(`执行失败: ${execResult.error}`)
      } else {
        toast.success(`执行完成: ${execResult.succeeded}项成功, ${rejectedActions.length}项被拒绝`)
      }
    } catch (err) {
      toast.error(`执行失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
    setSaving(false)
    setShowReview(false)
    router.push('/documents')
  }

  const handleReject = async () => {
    const supabase = createClient()
    const { error } = await supabase.from('uploaded_documents').update({ status: 'rejected' }).eq('id', id)
    if (error) { toast.error(`操作失败: ${error.message}`); return }
    toast.info('文档已拒绝')
    router.push('/documents')
  }

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
  if (!doc) return <div className="flex items-center justify-center h-full"><p className="text-muted-foreground">文档未找到</p></div>

  const fieldTemplate = doc.doc_category ? FIELD_TEMPLATES[doc.doc_category as DocCategory] || [] : []
  const matches = (doc.extracted_fields?._matches || []) as { type: string; matched_name: string; detail: string; confidence: number; confidence_level?: string }[]
  const summary = doc.extracted_fields?._summary as string || ''
  const fieldConfidence = (doc.extracted_fields?._field_confidence || {}) as Record<string, number>
  const missingFields = (doc.extracted_fields?._missing_fields || []) as string[]
  const highRiskFields = (doc.extracted_fields?._high_risk_fields || []) as string[]
  const duplicateProb = (doc.extracted_fields?._duplicate_probability || 0) as number

  // 必须确认的字段
  const requireConfirmFields = ['total_amount', 'amount', 'currency', 'customer_name', 'supplier_name', 'payer_name', 'quantity']

  return (
    <div className="flex flex-col h-full">
      <Header title="文档确认" subtitle={doc.file_name} />
      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        <div className="flex items-center justify-between">
          <Link href="/documents"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />返回文档中心</Button></Link>
          <div className="flex gap-2">
            <Button variant="destructive" size="sm" onClick={handleReject}><XCircle className="h-4 w-4 mr-1" />拒绝</Button>
            <Button size="sm" variant="outline" onClick={handlePreview} disabled={previewLoading || saving}>
              {previewLoading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Eye className="h-4 w-4 mr-1" />}
              预览执行
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 左侧：文件信息 + 匹配结果 */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">AI识别结果</CardTitle>
                  <Badge variant={doc.doc_category_confidence && doc.doc_category_confidence > 0.8 ? 'default' : 'secondary'}>
                    {DOC_CATEGORY_LABELS[doc.doc_category as DocCategory] || '未识别'} ({Math.round((doc.doc_category_confidence || 0) * 100)}%)
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
                  <Sparkles className="h-4 w-4 text-primary shrink-0" />
                  <p className="text-sm">{summary || '正在分析...'}</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><span className="text-muted-foreground">文件类型: </span>{doc.file_type}</div>
                  <div><span className="text-muted-foreground">大小: </span>{doc.file_size ? `${(doc.file_size / 1024).toFixed(1)}KB` : '-'}</div>
                </div>

                {/* 重复警告 */}
                {duplicateProb >= 50 && (
                  <div className="flex items-center gap-2 p-2 bg-red-50 rounded-lg text-red-700 text-sm" role="alert">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>重复概率 {duplicateProb}% — 该文件可能已上传过</span>
                  </div>
                )}

                {/* 缺失字段 */}
                {missingFields.length > 0 && (
                  <div className="flex items-start gap-2 p-2 bg-amber-50 rounded-lg text-amber-700 text-sm">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">缺失字段:</p>
                      <p className="text-xs">{missingFields.join('、')}</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 匹配结果 */}
            {matches.length > 0 && (
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">自动匹配结果</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {matches.map((m, i) => (
                    <div key={i} className={`flex items-center gap-2 p-2 rounded-lg text-sm ${
                      m.type === 'duplicate' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
                    }`}>
                      {m.type === 'duplicate' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle className="h-3.5 w-3.5 shrink-0" />}
                      <span>{m.detail}</span>
                      <Badge variant="outline" className="ml-auto text-[10px]">{Math.round(m.confidence * 100)}%</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* 建议操作 */}
            {actions.length > 0 && (
              <Card>
                <CardHeader className="pb-3"><CardTitle className="text-sm">建议操作</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {actions.map(a => (
                    <div key={a.id} className="flex items-center justify-between p-2 bg-blue-50 rounded-lg">
                      <span className="text-sm">{ACTION_TYPE_LABELS[a.action_type as keyof typeof ACTION_TYPE_LABELS] || a.action_type}</span>
                      <Badge variant="outline" className="text-[10px]">{a.status === 'suggested' ? '待确认' : a.status}</Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>

          {/* 右侧：字段编辑表单 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">提取字段（可编辑）</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {fieldTemplate.map(f => {
                const value = editedFields[f.field]
                const isRequired = requireConfirmFields.includes(f.field)
                const originalValue = doc.extracted_fields?.[f.field]
                const isChanged = JSON.stringify(value) !== JSON.stringify(originalValue)

                if (f.field === 'items') return null // 明细行单独处理

                return (
                  <div key={f.field} className="space-y-1">
                    <Label className="text-xs flex items-center gap-1">
                      {f.label}
                      {isRequired && <span className="text-red-500">*</span>}
                      {highRiskFields.includes(f.field) && <Badge variant="destructive" className="text-[8px]">需确认</Badge>}
                      {fieldConfidence[f.field] != null && (
                        <span className={`text-[9px] ${fieldConfidence[f.field] >= 80 ? 'text-green-600' : fieldConfidence[f.field] >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                          {fieldConfidence[f.field]}%
                        </span>
                      )}
                      {isChanged && <Badge variant="secondary" className="text-[9px]">已修改</Badge>}
                    </Label>
                    <Input
                      className={`h-8 text-sm ${
                        highRiskFields.includes(f.field) ? 'border-red-400 bg-red-50/30' :
                        isChanged ? 'border-amber-400 bg-amber-50' :
                        fieldConfidence[f.field] != null && fieldConfidence[f.field] < 50 ? 'border-amber-300 bg-amber-50/30' : ''
                      }`}
                      value={String(value ?? '')}
                      onChange={e => setEditedFields({ ...editedFields, [f.field]: e.target.value })}
                    />
                  </div>
                )
              })}

              {/* 额外提取的字段（不在模板中的） */}
              <Separator />
              <p className="text-xs text-muted-foreground">其他提取字段</p>
              {Object.entries(editedFields)
                .filter(([k]) => !k.startsWith('_') && !fieldTemplate.some(f => f.field === k) && k !== 'items')
                .map(([key, value]) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-xs">{key}</Label>
                    <Input className="h-8 text-sm" value={String(value ?? '')} onChange={e => setEditedFields({ ...editedFields, [key]: e.target.value })} />
                  </div>
                ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Pre-Execution Review Modal */}
      {previewData && (
        <PreExecutionReview
          open={showReview}
          onClose={() => setShowReview(false)}
          onConfirm={handleExecute}
          loading={saving}
          safetyAssessment={(previewData as Record<string, unknown>).safety_assessment as Parameters<typeof PreExecutionReview>[0]['safetyAssessment']}
          actions={((previewData as Record<string, unknown>).actions || []) as Parameters<typeof PreExecutionReview>[0]['actions']}
        />
      )}
    </div>
  )
}
