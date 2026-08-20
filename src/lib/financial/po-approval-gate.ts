/**
 * 采购单财务审批闸门(2026-08-03)
 *
 * 背景(老板 & Yoga 反馈的真实事故):
 *   · 小吴提交的对账单金额与供应商汇总不一致 → 海莲签了字、圆圆没发现 → 一路批过;
 *   · 要扣加工厂的几笔费用(合计 ¥1500)圆圆忘了登记;
 *   · 提交的资料缺件。
 *   共同点:系统【算得出】差异,却只用一行小字提示,批准按钮不受约束 ——
 *   等于把"发现问题"外包给人的眼睛,最后全靠 Yoga 兜底。生产实证:
 *   PO-20260727-001 明细行合计 ¥7,176 vs 单头 ¥7,020,差 ¥156,状态已批准。
 *
 * 老板决策(2026-08-03):金额对不上【绝对不能过】,必须改到一致。
 *   → 合法差异(谈好的零头折让)不再"点确认放过",而必须由采购落成一条具名的
 *     扣款/折让行使总额配平;否则财务只能驳回。差额不再消失在一句"差 ¥156"里。
 *
 * 本模块只做判定(纯函数、可测),不碰 UI 也不写库。
 */

const num = (v: unknown) => Number(v) || 0
const r2 = (v: number) => Math.round(v * 100) / 100
/** 金额比对容差:一分钱。低于此视为相等(浮点/四舍五入噪声) */
export const AMOUNT_EPSILON = 0.01

export interface PoLineLike {
  amount?: number | string | null
  material_name?: string | null
  po_amount?: number | string | null
  supplier_amount?: number | string | null
}

export interface GateCheck {
  id: string
  label: string
  passed: boolean
  /** 未通过时给出的具体差异说明(要能直接照着去改,不能只说"不一致") */
  detail?: string
  /** true = 不通过就不许批准;false = 仅提示 */
  blocking: boolean
}

export interface GateInput {
  /** 单头金额(节拍器推来的采购单总额) */
  headerAmount?: number | string | null
  currency?: string | null
  /** 采购单行(fin_po_lines) */
  lines?: PoLineLike[]
  /** 对账明细行(payable_records.detail.lines):含采购口径与供应商口径两列 */
  reconLines?: PoLineLike[] | null
  /** 关联订单中尚未建预算单的数量(既有闸门) */
  missingBudgetCount?: number
  /** 财务是否已就"本单扣款"作出显式声明(过渡手段,防"忘了填") */
  deductionDeclared?: boolean
  /**
   * 该供应商/该单尚未处理的待扣款(supplier_deductions.status='pending')。
   * 事件驱动:验货不合格/补料/返工发生时系统已自动建档 —— 这是防"不知道有"的根治手段,
   * 比让人勾选强得多:系统【先于人】知道该扣钱。未处理完不许批准放行。
   */
  pendingDeductions?: { id?: string; amount?: number | string | null; reason?: string | null; event_type?: string | null }[]
  /**
   * 资料齐备校验开关。⚠️ 默认关闭:截至 2026-08-03 生产库中挂到采购单的附件为 0 份
   * (节拍器尚未按 purchase_order.approval_requested 的 attachments[] 契约推送),
   * 此时开启会导致【全部在途采购单无法审批】。待附件真正流转后再打开。
   */
  requireAttachments?: boolean
  attachmentCount?: number
}

export interface GateResult {
  checks: GateCheck[]
  /** 全部 blocking 项通过才可批准 */
  canApprove: boolean
  blockers: GateCheck[]
}

export function checkPoApproval(input: GateInput): GateResult {
  const cur = input.currency || ''
  const money = (v: number) => `${cur} ${r2(v).toLocaleString()}`.trim()
  const checks: GateCheck[] = []

  // ① 明细行合计 = 单头金额 —— 小吴那张单栽的就是这里
  const lines = input.lines || []
  const header = r2(num(input.headerAmount))
  if (lines.length > 0) {
    // ⚠️ 比较用【未取整】的原始差额:先 r2 再比会把 100.005 变成 100.01,
    //    让 0.01 的容差在边界上失效(反而把噪声当成真差异拦下)。取整只用于展示。
    const rawSum = lines.reduce((s, l) => s + num(l.amount), 0)
    const rawDiff = rawSum - num(input.headerAmount)
    const sum = r2(rawSum)
    const diff = r2(rawDiff)
    checks.push({
      id: 'lines_vs_header',
      label: '明细行合计 = 单头金额',
      passed: Math.abs(rawDiff) < AMOUNT_EPSILON,
      detail: Math.abs(rawDiff) < AMOUNT_EPSILON ? undefined
        : `明细 ${lines.length} 行合计 ${money(sum)}，单头 ${money(header)}，差 ${diff > 0 ? '+' : ''}${r2(diff).toLocaleString()}。`
          + `请采购把差额落成一条具名的扣款/折让行使其配平，或改正错误行后重新提交。`,
      blocking: true,
    })
  } else {
    checks.push({
      id: 'lines_present',
      label: '采购单带明细行',
      passed: false,
      detail: '节拍器未推送逐料明细，无法核对金额构成 —— 财务无从判断这笔钱花在什么上。',
      blocking: true,
    })
  }

  // ② 供应商对账口径 = 采购订单口径 —— 「提交的单子和供应商汇总的金额不一致」
  const rl = input.reconLines || []
  if (rl.length > 0) {
    const rawPo = rl.reduce((s, l) => s + num(l.po_amount), 0)
    const rawSup = rl.reduce((s, l) => s + num(l.supplier_amount), 0)
    const rawDiff = rawSup - rawPo            // 同上:用原始值比,取整只为展示
    const po = r2(rawPo), sup = r2(rawSup), diff = r2(rawDiff)
    const bad = rl.filter(l => Math.abs(num(l.supplier_amount) - num(l.po_amount)) >= AMOUNT_EPSILON)
    checks.push({
      id: 'supplier_vs_po',
      label: '供应商对账金额 = 采购订单金额',
      passed: Math.abs(rawDiff) < AMOUNT_EPSILON,
      detail: Math.abs(rawDiff) < AMOUNT_EPSILON ? undefined
        : `采购口径 ${money(po)}，供应商口径 ${money(sup)}，差 ${diff > 0 ? '+' : ''}${r2(diff).toLocaleString()}`
          + (bad.length ? `；对不上的 ${bad.length} 行：${bad.slice(0, 5).map(l => l.material_name || '(未命名)').join('、')}` : ''),
      blocking: true,
    })
  }

  // ③ 预算闸门(既有规则:关联订单须先有预算单)
  if ((input.missingBudgetCount ?? 0) > 0) {
    checks.push({
      id: 'budget_exists',
      label: '关联订单已建预算单',
      passed: false,
      detail: `还有 ${input.missingBudgetCount} 张关联订单没有预算单，先生成预算单才能批准放行。`,
      blocking: true,
    })
  }

  // ④-a 事件驱动待扣款 —— 治「不知道有」(根治手段)
  //     验货不合格/补料/返工发生时,系统已自动建了待扣款档。这里未处理完就不许放行,
  //     所以不再依赖任何人"记得"——系统先于人知道该扣钱。
  const pend = input.pendingDeductions || []
  if (pend.length > 0) {
    const sum = r2(pend.reduce((s, d) => s + num(d.amount), 0))
    const evLabel: Record<string, string> = { qc_failed: '验货不合格', material_resupplied: '补原辅料', rework: '返工', manual: '手工登记' }
    checks.push({
      id: 'pending_deductions',
      label: '待扣款已处理',
      passed: false,
      detail: `本供应商/本单还有 ${pend.length} 笔待扣款未处理，合计 ${money(sum)}：`
        + pend.slice(0, 5).map(d => `${evLabel[String(d.event_type)] || '事件'} ${money(num(d.amount))}${d.reason ? `（${d.reason}）` : ''}`).join('；')
        + `。请在对账中扣除，或经审批豁免后再放行。`,
      blocking: true,
    })
  }

  // ④-b 扣款显式声明 —— 治「忘了填」
  //     2026-08-19 语义修正(fiona 反馈):下单时扣款多半尚未发生,财务无法为"本单永远无扣款"
  //     背书 —— 声明只对【截至目前已知】的扣款/折让负责。未来扣款的防线是 ④-a:
  //     qc.failed / material.resupplied / rework 事件(节拍器侧已上线)自动建待扣款档,
  //     付款/对账放行前 pending_deductions 硬闸强制处理,不依赖任何人预判。
  checks.push({
    id: 'deduction_declared',
    label: '已核对当前已知扣款（有则已入明细 / 暂无则声明）',
    passed: !!input.deductionDeclared,
    detail: input.deductionDeclared ? undefined
      : '请确认截至目前已知的扣款/折让（如已谈定的折让）已登记入明细；暂无已知扣款则勾选声明。下单后新发生的扣款由验货/补料/返工事件自动建档，付款对账时强制冲抵，无需预判。',
    blocking: true,
  })

  // ⑤ 资料齐备(默认关闭,见 requireAttachments 注释)
  if (input.requireAttachments) {
    const cnt = input.attachmentCount ?? 0
    checks.push({
      id: 'attachments',
      label: '资料齐备（对账单／送货单等附件）',
      passed: cnt > 0,
      detail: cnt > 0 ? undefined : '本单没有任何附件，无法核对来源单据。',
      blocking: true,
    })
  }

  const blockers = checks.filter(c => c.blocking && !c.passed)
  return { checks, canApprove: blockers.length === 0, blockers }
}
