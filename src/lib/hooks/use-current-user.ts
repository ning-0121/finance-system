'use client'

import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { demoUsers } from '@/lib/demo-data'
import type { User } from '@/lib/types'

const DEMO_USER_KEY = 'finance_demo_user'

export function useCurrentUser() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [isDemo, setIsDemo] = useState(false)

  useEffect(() => {
    let mounted = true

    async function init() {
      try {
        const supabase = createClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()

        if (authUser) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', authUser.id)
            .single()

          if (profile && mounted) {
            setUser(profile as User)
            setIsDemo(false)
            setLoading(false)
            return
          }
        }
      } catch {
        // Supabase 不可用
      }

      if (!mounted) return

      // 降级到演示模式
      const saved = typeof window !== 'undefined' ? localStorage.getItem(DEMO_USER_KEY) : null
      const key = (saved === 'su' || saved === 'fiona') ? saved : 'fiona'
      setUser(demoUsers[key])
      setIsDemo(true)
      setLoading(false)
    }

    init()
    return () => { mounted = false }
  }, [])

  const switchDemoUser = useCallback((key: 'su' | 'fiona') => {
    localStorage.setItem(DEMO_USER_KEY, key)
    setUser(demoUsers[key])
    setIsDemo(true)
  }, [])

  return { user, loading, isDemo, switchDemoUser }
}
