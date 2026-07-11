// POST /api/purchase-approvals/extract-quote — 识别内部报价单(按需,财务在审批页触发)
// AI 只做提取建议:结果写 uploaded_documents.extracted_fields(识别工件,非财务数据),
// 预算落库另走 create-budget-from-quote,由财务调整确认后以真实 auth.uid() 写入。
import { NextResponse, type NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'
import { extractQuoteFromFile, extractQuoteFromText, type QuoteExtraction } from '@/lib/document-engine/quote-extractor'

const IMG_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
}

async function fetchFileBytes(fileUrl: string): Promise<{ bytes: ArrayBuffer } | { error: string }> {
  // 节拍器侧 URL(http/https) → 直接拉;否则当作 finance-attachments 桶内路径
  if (/^https?:\/\//i.test(fileUrl)) {
    try {
      const res = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) return { error: `拉取文件失败 HTTP ${res.status}` }
      return { bytes: await res.arrayBuffer() }
    } catch (e) { return { error: `拉取文件失败: ${e instanceof Error ? e.message : '网络错误'}` } }
  }
  const svc = createServiceClient()
  const { data, error } = await svc.storage.from('finance-attachments').download(fileUrl)
  if (error || !data) return { error: `存储下载失败: ${error?.message || '未知'}` }
  return { bytes: await data.arrayBuffer() }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const roleErr = requireRole(auth, ['finance_staff', 'finance_manager', 'admin'])
  if (roleErr) return roleErr

  try {
    const { document_id, force } = await request.json() as { document_id?: string; force?: boolean }
    if (!document_id) return NextResponse.json({ error: '缺少 document_id' }, { status: 400 })

    const supabase = await createClient()
    const { data: doc, error: docErr } = await supabase.from('uploaded_documents')
      .select('id, file_name, file_url, extracted_fields, doc_category, status')
      .eq('id', document_id).maybeSingle()
    if (docErr || !doc) return NextResponse.json({ error: `文档不存在: ${docErr?.message || document_id}` }, { status: 404 })

    // 已识别过且非强制重识别 → 直接回缓存(省 token,防重复调用)
    const cached = (doc.extracted_fields as Record<string, unknown>)?._quote as QuoteExtraction | undefined
    if (cached?.success && !force) return NextResponse.json({ success: true, cached: true, quote: cached })

    if (!doc.file_url) return NextResponse.json({ error: '该文档没有可用的文件地址(file_url 为空),请让节拍器补推附件' }, { status: 400 })

    const fetched = await fetchFileBytes(doc.file_url as string)
    if ('error' in fetched) return NextResponse.json({ error: fetched.error }, { status: 502 })

    // 按扩展名路由:Excel/CSV → 转文本;PDF/图片 → vision
    const ext = (String(doc.file_name || '').split('.').pop() || '').toLowerCase()
    let quote: QuoteExtraction
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      const wb = XLSX.read(new Uint8Array(fetched.bytes), { type: 'array' })
      const csv = wb.SheetNames.slice(0, 3)
        .map(n => `--- Sheet: ${n} ---\n${XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false })}`)
        .join('\n\n')
      quote = await extractQuoteFromText(csv, String(doc.file_name))
    } else if (ext === 'pdf' || IMG_TYPES[ext]) {
      const b64 = Buffer.from(fetched.bytes).toString('base64')
      quote = await extractQuoteFromFile(b64, ext === 'pdf' ? 'application/pdf' : IMG_TYPES[ext], String(doc.file_name))
    } else {
      return NextResponse.json({ error: `不支持的文件类型 .${ext}(支持 xlsx/xls/csv/pdf/jpg/png/webp)` }, { status: 400 })
    }

    if (!quote.success) return NextResponse.json({ error: quote.error || '识别失败', quote }, { status: 422 })

    // 识别工件落 extracted_fields._quote(只读建议;不动任何财务表)
    const { error: updErr } = await supabase.from('uploaded_documents').update({
      extracted_fields: { ...(doc.extracted_fields as Record<string, unknown> || {}), _quote: quote },
      doc_category: 'internal_quote',
      status: 'extracted',
    }).eq('id', document_id)
    if (updErr) console.error('[extract-quote] 保存识别结果失败:', updErr.message)

    return NextResponse.json({ success: true, cached: false, quote })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '识别失败' }, { status: 500 })
  }
}
