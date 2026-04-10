'use client'

import { useState, useEffect, useCallback } from 'react'
import { Header } from '@/components/layout/Header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import { Upload, FileText, Loader2, CheckCircle, Clock, AlertTriangle, Eye, Brain } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { DOC_CATEGORY_LABELS, type UploadedDocument, type DocCategory } from '@/lib/types/document'
import Link from 'next/link'

const statusConfig: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  pending: { label: '待处理', color: 'bg-gray-100 text-gray-700', icon: Clock },
  extracting: { label: '识别中', color: 'bg-blue-100 text-blue-700', icon: Brain },
  extracted: { label: '待确认', color: 'bg-amber-100 text-amber-700', icon: AlertTriangle },
  confirmed: { label: '已确认', color: 'bg-green-100 text-green-700', icon: CheckCircle },
  rejected: { label: '已拒绝', color: 'bg-red-100 text-red-700', icon: AlertTriangle },
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<UploadedDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    async function load() {
      try {
        const supabase = createClient()
        const { data } = await supabase
          .from('uploaded_documents')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50)
        if (data) setDocs(data as UploadedDocument[])
      } catch { /* demo */ }
      setLoading(false)
    }
    load()
  }, [])

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        body: formData,
      })
      const result = await res.json()

      if (result.error) {
        toast.error(`上传失败: ${result.error}`)
      } else {
        toast.success(`文件已上传并识别`, {
          description: `${DOC_CATEGORY_LABELS[result.doc_category as DocCategory] || '未知类型'} (${Math.round((result.confidence || 0) * 100)}%置信度)`,
        })
        // 刷新列表
        const supabase = createClient()
        const { data } = await supabase.from('uploaded_documents').select('*').order('created_at', { ascending: false }).limit(50)
        if (data) setDocs(data as UploadedDocument[])
      }
    } catch {
      toast.error('上传失败')
    }
    setUploading(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleUpload(file)
  }, [handleUpload])

  const filtered = filter === 'all' ? docs : docs.filter(d => d.status === filter)
  const pendingCount = docs.filter(d => d.status === 'extracted').length

  return (
    <div className="flex flex-col h-full">
      <Header title="文档智能中心" subtitle="上传任何文件 → AI自动识别 → 提取字段 → 匹配数据 → 人工确认" />

      <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto">
        {/* 上传区 */}
        <div
          className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${uploading ? 'border-primary bg-primary/5' : 'hover:border-primary/50 hover:bg-muted/30 cursor-pointer'}`}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => {
            if (uploading) return
            const input = document.createElement('input')
            input.type = 'file'
            input.accept = '.xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.webp'
            input.onchange = e => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) handleUpload(f) }
            input.click()
          }}
        >
          {uploading ? (
            <div className="flex items-center justify-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <div className="text-left">
                <p className="font-medium">AI正在分析文件...</p>
                <p className="text-sm text-muted-foreground">自动分类 → 字段提取 → 数据匹配</p>
              </div>
            </div>
          ) : (
            <>
              <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              <p className="font-medium">拖放文件到此处 或 点击选择</p>
              <p className="text-sm text-muted-foreground mt-1">支持 Excel · PDF · 图片（JPG/PNG） · 银行回单 · 各类财务单据</p>
              <p className="text-xs text-muted-foreground mt-1">AI自动识别18种文件类型，提取关键字段，匹配系统数据</p>
            </>
          )}
        </div>

        {/* 统计+筛选 */}
        <div className="flex items-center justify-between">
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList>
              <TabsTrigger value="all">全部 ({docs.length})</TabsTrigger>
              <TabsTrigger value="extracted" className={pendingCount > 0 ? 'text-amber-600' : ''}>
                待确认 ({pendingCount})
              </TabsTrigger>
              <TabsTrigger value="confirmed">已确认</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Brain className="h-4 w-4" />
            <span>AI引擎: Claude Vision</span>
          </div>
        </div>

        {/* 文档列表 */}
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {loading ? (
              <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>暂无文档</p>
                <p className="text-xs mt-1">上传财务单据，AI会自动识别和提取</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>文件名</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>文件类别</TableHead>
                    <TableHead>置信度</TableHead>
                    <TableHead>匹配</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>上传时间</TableHead>
                    <TableHead className="text-center">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(doc => {
                    const sc = statusConfig[doc.status] || statusConfig.pending
                    return (
                      <TableRow key={doc.id}>
                        <TableCell className="font-medium max-w-[200px] truncate">{doc.file_name}</TableCell>
                        <TableCell><Badge variant="outline">{doc.file_type}</Badge></TableCell>
                        <TableCell>
                          {doc.doc_category ? (
                            <Badge variant="secondary">{DOC_CATEGORY_LABELS[doc.doc_category as DocCategory] || doc.doc_category}</Badge>
                          ) : '-'}
                        </TableCell>
                        <TableCell>
                          {doc.doc_category_confidence != null ? (
                            <span className={`text-sm font-medium ${doc.doc_category_confidence > 0.8 ? 'text-green-600' : doc.doc_category_confidence > 0.5 ? 'text-amber-600' : 'text-red-600'}`}>
                              {Math.round(doc.doc_category_confidence * 100)}%
                            </span>
                          ) : '-'}
                        </TableCell>
                        <TableCell className="text-sm">
                          {doc.matched_customer && <div className="text-green-600">客户: {doc.matched_customer}</div>}
                          {doc.matched_supplier && <div className="text-blue-600">供应商: {doc.matched_supplier}</div>}
                          {!doc.matched_customer && !doc.matched_supplier && <span className="text-muted-foreground">-</span>}
                        </TableCell>
                        <TableCell>
                          <Badge className={`${sc.color} border-0`}>{sc.label}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(doc.created_at).toLocaleString('zh-CN')}
                        </TableCell>
                        <TableCell className="text-center">
                          {doc.status === 'extracted' && (
                            <Link href={`/documents/${doc.id}`}>
                              <Button size="sm"><Eye className="h-3.5 w-3.5 mr-1" />确认</Button>
                            </Link>
                          )}
                          {doc.status === 'confirmed' && (
                            <span className="text-xs text-green-600">✓ 已入库</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
