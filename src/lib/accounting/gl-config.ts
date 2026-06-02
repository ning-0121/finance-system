// ============================================================
// GL 受控灰度配置（服务端）
//
// 默认（试运行边界）：
//   - GL_AUTO_POST_ENABLED=false  自动过账总开关，默认关闭
//   - GL_DRAFT_ONLY=true          仅生成 draft，默认开启
//   - GL_REVIEW_THRESHOLD_CNY=0   ≥ 阈值的凭证一律 requires_review；
//                                 默认 0 ⇒ 任何金额都需人工复核
//
// 只有同时满足以下全部条件才允许「自动 posted」：
//   1) GL_AUTO_POST_ENABLED=true
//   2) GL_DRAFT_ONLY=false
//   3) 凭证金额（CNY）< GL_REVIEW_THRESHOLD_CNY（低风险）
//
// 任何不满足者 → 生成 draft + requires_review=true，等财务经理 review 后再 post。
// ============================================================

const TRUE_SET = new Set(['true', '1', 'yes', 'on'])

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (v == null || v === '') return def
  return TRUE_SET.has(v.trim().toLowerCase())
}

function envNum(name: string, def: number): number {
  const v = process.env[name]
  if (v == null || v === '') return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

export interface GlConfig {
  autoPostEnabled: boolean
  draftOnly: boolean
  reviewThresholdCny: number
}

/** 读取当前 GL 灰度配置（每次读取以便测试可通过环境变量切换）。 */
export function getGlConfig(): GlConfig {
  return {
    autoPostEnabled: envBool('GL_AUTO_POST_ENABLED', false),
    draftOnly: envBool('GL_DRAFT_ONLY', true),
    reviewThresholdCny: envNum('GL_REVIEW_THRESHOLD_CNY', 0),
  }
}

/**
 * 是否允许对该金额的凭证「自动 posted」。
 * 默认配置下恒为 false（仅生成 draft）。
 */
export function shouldAutoPost(amountCny: number, cfg: GlConfig = getGlConfig()): boolean {
  if (!cfg.autoPostEnabled) return false
  if (cfg.draftOnly) return false
  if (!Number.isFinite(amountCny)) return false
  // 阈值含义：金额达到/超过阈值即视为高风险，必须人工复核
  return Math.abs(amountCny) < cfg.reviewThresholdCny
}

/** 该金额的 draft 是否需要人工复核（与 shouldAutoPost 互补）。 */
export function requiresReview(amountCny: number, cfg: GlConfig = getGlConfig()): boolean {
  return !shouldAutoPost(amountCny, cfg)
}
