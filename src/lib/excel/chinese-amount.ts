// ============================================================
// 中文大写金额转换 — 财务规范
// 例：12345.67 → 壹万贰仟叁佰肆拾伍元陆角柒分
// ============================================================

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const UNITS = ['', '拾', '佰', '仟']
const BIG_UNITS = ['', '万', '亿', '兆']

export function toChineseUppercase(amount: number): string {
  if (amount === 0) return '零元整'
  if (isNaN(amount)) return ''

  const negative = amount < 0
  amount = Math.abs(amount)

  // 分离整数和小数部分（精确到分）
  const rounded = Math.round(amount * 100) / 100
  const intPart = Math.floor(rounded)
  const decPart = Math.round((rounded - intPart) * 100)

  const jiao = Math.floor(decPart / 10)
  const fen = decPart % 10

  let result = negative ? '负' : ''

  // 整数部分
  if (intPart === 0) {
    result += '零'
  } else {
    result += integerToChinese(intPart)
  }

  result += '元'

  // 小数部分
  if (jiao === 0 && fen === 0) {
    result += '整'
  } else if (jiao === 0) {
    result += '零' + DIGITS[fen] + '分'
  } else if (fen === 0) {
    result += DIGITS[jiao] + '角整'
  } else {
    result += DIGITS[jiao] + '角' + DIGITS[fen] + '分'
  }

  return result
}

function integerToChinese(n: number): string {
  if (n === 0) return DIGITS[0]

  const str = n.toString()
  const sections: number[] = []

  // 每4位一组
  for (let i = str.length; i > 0; i -= 4) {
    const start = Math.max(0, i - 4)
    sections.unshift(parseInt(str.slice(start, i)))
  }

  let result = ''
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    const bigUnit = BIG_UNITS[sections.length - 1 - i]

    if (section === 0) {
      if (result && !result.endsWith('零')) result += '零'
      continue
    }

    const sectionStr = sectionToChinese(section)

    // 如果本节不足4位且前面有内容，需补零
    if (result && section < 1000 && i > 0) {
      if (!result.endsWith('零')) result += '零'
    }

    result += sectionStr + bigUnit
  }

  return result
}

function sectionToChinese(n: number): string {
  if (n === 0) return ''

  const digits = n.toString().split('').map(Number)
  let result = ''
  let prevZero = false

  for (let i = 0; i < digits.length; i++) {
    const d = digits[i]
    const unitIdx = digits.length - 1 - i

    if (d === 0) {
      prevZero = true
    } else {
      if (prevZero && result) result += '零'
      result += DIGITS[d] + UNITS[unitIdx]
      prevZero = false
    }
  }

  return result
}
