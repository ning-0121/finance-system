// ============================================================
// 公司信息 + 签字栏配置 — 财务报表通用
// ============================================================

export const companyInfo = {
  name_cn: '绮陌服饰',
  name_en: 'QIMO Clothing',
  full_name: '绮陌服饰 QIMO Clothing',
  address: '',        // 可后续配置
  phone: '',

  // 签字栏人员
  preparer: { name: '方圆', title: '制表人' },
  reviewer: { name: 'Su', title: '审核人' },
  approver: { name: '', title: '审批人' },  // 留空盖章
}

export const reportStyles = {
  headerFontSize: 16,
  titleFontSize: 14,
  bodyFontSize: 11,
  headerRowHeight: 30,
  titleRowHeight: 25,
  dataRowHeight: 20,
  signatureRowHeight: 30,
}
