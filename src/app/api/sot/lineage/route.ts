// ============================================================
// GET /api/sot/lineage?table=...&row_id=...&field=...&history=true
// ============================================================
// 读取字段血缘（current 或 history）
// ============================================================

import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/api-guard'
import { getLineage, getLineageHistory } from '@/lib/sot/lineage'

export async function GET(request: NextRequest) {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!

  const { searchParams } = request.nextUrl
  const table = searchParams.get('table')
  const rowId = searchParams.get('row_id')
  const field = searchParams.get('field')
  const wantHistory = searchParams.get('history') === 'true'

  if (!table || !rowId) {
    return NextResponse.json(
      { error: 'missing required params: table, row_id' },
      { status: 400 }
    )
  }

  if (wantHistory) {
    const history = await getLineageHistory(table, rowId, field || undefined, 50)
    return NextResponse.json({ history })
  }

  if (!field) {
    return NextResponse.json(
      { error: 'missing required param: field (or pass history=true)' },
      { status: 400 }
    )
  }

  const lineage = await getLineage(table, rowId, field)
  return NextResponse.json({ lineage })
}
