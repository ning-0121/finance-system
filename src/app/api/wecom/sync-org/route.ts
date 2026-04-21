// ============================================================
// POST /api/wecom/sync-org — 同步企业微信组织架构到系统
// 安全：仅admin角色可调用
// ============================================================

import { NextResponse } from 'next/server'
import { getDepartmentList, getDepartmentUsers, isWecomConfigured } from '@/lib/wecom/client'
import { createClient } from '@/lib/supabase/server'
import { requireAuth, requireRole } from '@/lib/auth/api-guard'

export async function POST() {
  const auth = await requireAuth()
  if (!auth.authenticated) return auth.error!
  const roleErr = requireRole(auth, ['admin'])
  if (roleErr) return roleErr

  if (!isWecomConfigured()) {
    return NextResponse.json({ error: '企业微信未配置' }, { status: 400 })
  }

  try {
    const supabase = await createClient()

    // 1. 获取部门列表
    const deptResult = await getDepartmentList()
    if (deptResult.errcode !== 0) {
      return NextResponse.json({ error: `部门获取失败: ${deptResult.errmsg}` }, { status: 500 })
    }

    const departments = (deptResult.department || []) as { id: number; name: string; parentid: number }[]
    let syncedUsers = 0

    // 2. 遍历部门获取成员
    for (const dept of departments) {
      const usersResult = await getDepartmentUsers(dept.id)
      if (usersResult.errcode !== 0) continue

      const users = (usersResult.userlist || []) as {
        userid: string; name: string; email: string; mobile: string;
        department: number[]; position: string; avatar: string; status: number
      }[]

      for (const u of users) {
        if (u.status !== 1) continue // 只同步已激活的用户

        const email = u.email || `${u.userid}@qimoclothing.com`

        // 映射角色
        const role = mapPositionToRole(u.position, dept.name)

        // Upsert profile
        await supabase.from('profiles').upsert({
          email,
          name: u.name,
          role,
          department: dept.name,
          avatar_url: u.avatar || null,
        }, { onConflict: 'email' })

        syncedUsers++
      }
    }

    return NextResponse.json({
      status: 'ok',
      departments: departments.length,
      users_synced: syncedUsers,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

function mapPositionToRole(position: string, department: string): string {
  const p = (position || '').toLowerCase()
  const d = (department || '').toLowerCase()

  if (p.includes('总') || p.includes('boss') || p.includes('ceo')) return 'admin'
  if (p.includes('财务总监') || p.includes('财务主管')) return 'finance_manager'
  if (d.includes('财务') || p.includes('财务')) return 'finance_staff'
  if (d.includes('销售') || p.includes('销售') || p.includes('业务')) return 'sales'
  if (d.includes('采购') || p.includes('采购')) return 'procurement'
  if (d.includes('仓') || p.includes('出纳')) return 'cashier'

  return 'finance_staff' // 默认
}
