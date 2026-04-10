// ============================================================
// 通用重试工具 — 指数退避，适用于所有外部API调用
// ============================================================

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number; label?: string } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, label = 'operation' } = options
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500
        console.warn(`[Retry] ${label} attempt ${attempt + 1}/${maxRetries} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  throw lastError || new Error(`${label} failed after ${maxRetries} retries`)
}
