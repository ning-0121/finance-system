// ============================================================
// Phase A-1: 获取当前租户 id
// ============================================================
// 当前内部单租户阶段：所有用户默认归属 qimo。
// Phase C 商业化后改为从 tenant_users 关系动态查询。
// ============================================================

import { createClient } from '@/lib/supabase/server'

const QIMO_SLUG = 'qimo'

let _cachedTenantId: string | null = null
let _cachePromise: Promise<string | null> | null = null

/**
 * 获取当前租户 id（A-1 阶段固定返回 qimo 租户 id）。
 *
 * 失败时返回 null，调用方应当 fallback（shadow write 静默失败即可）。
 * 不抛错。
 */
export async function getCurrentTenantId(): Promise<string | null> {
  if (_cachedTenantId) return _cachedTenantId
  if (_cachePromise) return _cachePromise

  _cachePromise = (async () => {
    try {
      // 注意：tenant schema 必须已在 Supabase Dashboard "Exposed schemas"
      // 中暴露，否则此查询会 404。
      const supabase = await createClient()
      const { data, error } = await supabase
        .schema('tenant' as 'public')
        .from('tenants')
        .select('id')
        .eq('slug', QIMO_SLUG)
        .single()

      if (error || !data) {
        console.warn('[SoT] getCurrentTenantId: tenant lookup failed', error?.message)
        return null
      }
      _cachedTenantId = data.id as string
      return _cachedTenantId
    } catch (err) {
      console.warn('[SoT] getCurrentTenantId threw', err)
      return null
    } finally {
      _cachePromise = null
    }
  })()

  return _cachePromise
}

/** 测试用：清除缓存 */
export function _clearTenantCache(): void {
  _cachedTenantId = null
  _cachePromise = null
}
