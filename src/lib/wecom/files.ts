// ============================================================
// 企业微信文件存储 — 自动归档到企微网盘
// 系统只保存 file_id + metadata，原始文件在企微
// ============================================================

import { getAccessToken } from './client'

const BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin'

export interface WecomFileMetadata {
  file_id: string
  file_name: string
  file_url: string
  wecom_space_id: string
  file_size: number
  file_category: string
  related_order_id: string | null
  related_customer: string | null
  uploaded_by: string
  uploaded_at: string
}

/** 上传临时文件到企业微信 */
export async function uploadToWecom(
  fileBlob: Blob,
  filename: string,
  mediaType: 'file' | 'image' = 'file'
): Promise<{ mediaId: string; error?: string }> {
  try {
    const token = await getAccessToken()
    const formData = new FormData()
    formData.append('media', fileBlob, filename)

    const res = await fetch(
      `${BASE_URL}/media/upload?access_token=${token}&type=${mediaType}`,
      { method: 'POST', body: formData }
    )
    const data = await res.json()

    if (data.errcode !== 0) {
      return { mediaId: '', error: data.errmsg }
    }
    return { mediaId: data.media_id }
  } catch (e) {
    return { mediaId: '', error: e instanceof Error ? e.message : 'Upload failed' }
  }
}

/** 生成文件目录路径 */
export function generateFilePath(params: {
  customer: string
  year: string
  orderNo: string
  category: string  // PI/合同/面料/辅料/样品/QC/出货/回款
}): string {
  return `${params.customer}/${params.year}/${params.orderNo}/${params.category}`
}

/** 文件分类 */
export const FILE_CATEGORIES = [
  { key: 'pi', label: 'PI/报价' },
  { key: 'contract', label: '合同' },
  { key: 'fabric', label: '面料' },
  { key: 'accessory', label: '辅料' },
  { key: 'sample', label: '样品' },
  { key: 'qc', label: 'QC验货' },
  { key: 'shipping', label: '出货' },
  { key: 'payment', label: '回款' },
  { key: 'invoice', label: '发票' },
  { key: 'customs', label: '报关' },
  { key: 'other', label: '其他' },
] as const
