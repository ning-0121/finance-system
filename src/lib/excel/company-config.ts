// ============================================================
// 公司信息 + 签字栏配置 — 财务报表通用
// ============================================================

export const companyInfo = {
  name_cn: '义乌市绮陌服饰有限公司',
  name_en: 'YIWU QIMO CLOTHING CO.,LTD',
  full_name: '义乌市绮陌服饰有限公司',
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
