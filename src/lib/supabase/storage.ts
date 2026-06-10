// ============================================================
// 附件存储（Supabase Storage）— 财务附件（营业执照/开户许可证/银行回单等）
// 私有桶 finance-attachments；存路径，展示时按需生成签名 URL。
// 兼容历史：attachment_url 字段若是 http(s) 链接则直接打开；否则当存储路径处理。
// ============================================================
import { createClient } from './client'

const BUCKET = 'finance-attachments'

/** 上传文件，返回存储路径（存进 attachment_url 字段）。 */
export async function uploadAttachment(file: File, folder = 'misc'): Promise<{ path: string | null; error: string | null }> {
  try {
    if (file.size > 20 * 1024 * 1024) return { path: null, error: '文件超过 20MB' }
    const supabase = createClient()
    const safeName = file.name.replace(/[^\w.\-一-龥]+/g, '_')
    const rand = (globalThis.crypto?.randomUUID?.() ?? String(Math.round(performance.now()))).slice(0, 8)
    const path = `${folder}/${rand}_${safeName}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type || undefined })
    if (error) {
      if (/bucket.*not.*found/i.test(error.message)) return { path: null, error: '存储桶未创建：请先执行迁移 20260609_finance_attachments_storage.sql' }
      return { path: null, error: error.message }
    }
    return { path, error: null }
  } catch (e) { return { path: null, error: e instanceof Error ? e.message : '上传失败' } }
}

/** 取签名 URL（私有桶临时访问）。 */
export async function getAttachmentSignedUrl(path: string, expiresInSec = 3600): Promise<string | null> {
  try {
    const supabase = createClient()
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresInSec)
    return data?.signedUrl ?? null
  } catch { return null }
}

/** 打开附件：http(s) 链接直接开；否则按存储路径生成签名 URL 再开。 */
export async function openAttachment(value: string | null | undefined): Promise<void> {
  if (!value) return
  const url = /^https?:\/\//i.test(value) ? value : await getAttachmentSignedUrl(value)
  if (url) window.open(url, '_blank', 'noopener')
}

/** 取文件显示名（路径末段或链接末段）。 */
export function attachmentName(value: string | null | undefined): string {
  if (!value) return ''
  const seg = value.split('/').pop() || value
  return seg.replace(/^[a-f0-9]{8}_/i, '')
}
