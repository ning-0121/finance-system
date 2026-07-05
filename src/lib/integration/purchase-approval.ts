// 采购单审批阈值(≥¥5000 需财务审核)——服务端(webhook)与前端(工作台)共用同一口径。
// 老板 2026-07-05 定:单张采购单总额 ≥¥5000 需财务审批。若日后要严格「超过5000」改为 > 即可。
export const PURCHASE_APPROVAL_THRESHOLD_CNY = 5000

// 判断一张采购单是否触发审批。非 CNY 暂按原额比阈值(节拍器目前采购基本走 CNY;
// 如需按汇率折算,后续在此接入汇率即可,单点修改)。
export function poRequiresApproval(totalAmount: number | null | undefined): boolean {
  const amt = Number(totalAmount) || 0
  return amt >= PURCHASE_APPROVAL_THRESHOLD_CNY
}
