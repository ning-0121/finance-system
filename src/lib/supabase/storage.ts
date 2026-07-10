// ============================================================
// 附件存储（Supabase Storage）— 财务附件（营业执照/开户许可证/银行回单等）
// 私有桶 finance-attachments；存路径，展示时按需生成签名 URL。
// 兼容历史：attachment_url 字段若是 http(s) 链接则直接打开；否则当存储路径处理。
// ============================================================
import { createClient } from './client'

const BUCKET = 'finance-attachments'

// Supabase 存储对象键不接受中文等非 ASCII 字符(实测报 Invalid key,percent 编码也会被解码后再拒)。
// 财务附件几乎全是中文文件名 → 键名里中文部分用 base64url 编码并加 b64- 标记,
// 展示时由 attachmentName() 解码还原中文。ASCII 文件名不受影响,历史已存路径也兼容。
function encodeNameForKey(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot).replace(/[^\w.]/g, '') : ''
  if (/^[\w.\- ()+']+$/.test(base)) return `${base}${ext}`  // 纯安全 ASCII,原样保留
  const bytes = new TextEncoder().encode(base)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `b64-${b64url}${ext}`
}

/** 上传文件，返回存储路径（存进 attachment_url 字段）。 */
export async function uploadAttachment(file: File, folder = 'misc'): Promise<{ path: string | null; error: string | null }> {
  try {
    if (file.size > 20 * 1024 * 1024) return { path: null, error: '文件超过 20MB' }
    const supabase = createClient()
    const safeName = encodeNameForKey(file.name)
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

/** 取文件显示名（路径末段或链接末段）；b64- 标记的键名解码还原原始中文文件名。 */
export function attachmentName(value: string | null | undefined): string {
  if (!value) return ''
  const seg = value.split('/').pop() || value
  const stripped = seg.replace(/^[a-f0-9]{8}_/i, '')
  const m = stripped.match(/^b64-([A-Za-z0-9_-]+)(\.[\w.]*)?$/)
  if (m) {
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/')
      const bin = atob(b64)
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
      return new TextDecoder().decode(bytes) + (m[2] || '')
    } catch { /* 解码失败则原样展示 */ }
  }
  return stripped
}
