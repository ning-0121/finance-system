'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { CheckCircle, XCircle, AlertTriangle, Shield, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'

interface PreExecutionAction {
  action_type: string
  label: string
  safety_level: string
  safety_label: string
  responsible_role: string
  target_table: string
  creates_todo: boolean
  creates_approval: boolean
  rollback_supported: boolean
  can_execute: boolean
  skip_reason: string | null
  explanation: string
  impact_summary: string
}

interface SafetyGate {
  gate_name: string
  passed: boolean
  reason: string
}

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: (approvedActions: string[], rejectedActions: string[]) => void
  loading?: boolean
  safetyAssessment: {
    overall_safe: boolean
    max_allowed_level: string
    recommendation: string
    gates: SafetyGate[]
  } | null
  actions: PreExecutionAction[]
}

const levelColors: Record<string, string> = {
  L1: 'bg-green-100 text-green-700',
  L2: 'bg-blue-100 text-blue-700',
  L3: 'bg-amber-100 text-amber-700',
  L4: 'bg-red-100 text-red-700',
}

const roleLabels: Record<string, string> = {
  finance_staff: '方圆(财务)',
  finance_manager: 'Su(财务总监)',
  ceo: '老板',
}

export function PreExecutionReview({ open, onClose, onConfirm, loading, safetyAssessment, actions }: Props) {
  const [decisions, setDecisions] = useState<Record<string, boolean>>(() => {
    const d: Record<string, boolean> = {}
    actions.forEach(a => { d[a.action_type] = a.can_execute })
    return d
  })
  const [expandedAction, setExpandedAction] = useState<string | null>(null)

  const approvedActions = Object.entries(decisions).filter(([, v]) => v).map(([k]) => k)
  const rejectedActions = Object.entries(decisions).filter(([, v]) => !v).map(([k]) => k)

  const toggleAction = (actionType: string) => {
    setDecisions(prev => ({ ...prev, [actionType]: !prev[actionType] }))
  }

  const acceptAll = () => {
    const d: Record<string, boolean> = {}
    actions.forEach(a => { d[a.action_type] = a.can_execute })
    setDecisions(d)
  }

  const rejectAll = () => {
    const d: Record<string, boolean> = {}
    actions.forEach(a => { d[a.action_type] = false })
    setDecisions(d)
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            执行前预览 — 确认系统即将执行的全部操作
          </DialogTitle>
        </DialogHeader>

        {/* 安全门槛 */}
        {safetyAssessment && (
          <div className="space-y-2">
            <p className="text-sm font-medium">安全评估</p>
            <div className="grid grid-cols-2 gap-2">
              {safetyAssessment.gates.map((gate, i) => (
                <div key={i} className={`flex items-center gap-2 p-2 rounded-lg text-xs ${gate.passed ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                  {gate.passed ? <CheckCircle className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
                  <span>{gate.reason}</span>
                </div>
              ))}
            </div>
            <div className={`p-2 rounded-lg text-sm ${safetyAssessment.overall_safe ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
              {safetyAssessment.recommendation}
            </div>
          </div>
        )}

        <Separator />

        {/* 动作列表 */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">操作列表 ({actions.length}个)</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={acceptAll}>全部接受</Button>
              <Button variant="ghost" size="sm" className="text-xs h-7" onClick={rejectAll}>全部拒绝</Button>
            </div>
          </div>

          {actions.map(action => {
            const isAccepted = decisions[action.action_type] || false
            const isExpanded = expandedAction === action.action_type

            return (
              <div key={action.action_type} className={`border rounded-lg ${!action.can_execute ? 'opacity-50 bg-muted/30' : isAccepted ? 'border-green-200' : 'border-red-200'}`}>
                <div className="flex items-center gap-3 p-3">
                  {/* Accept/Reject toggle */}
                  <Checkbox
                    checked={isAccepted}
                    disabled={!action.can_execute}
                    onCheckedChange={() => toggleAction(action.action_type)}
                  />

                  {/* 动作信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{action.label}</span>
                      <Badge className={`${levelColors[action.safety_level] || ''} border-0 text-[9px]`}>
                        {action.safety_level} {action.safety_label}
                      </Badge>
                      <Badge variant="outline" className="text-[9px]">
                        {roleLabels[action.responsible_role] || action.responsible_role}
                      </Badge>
                      {action.creates_approval && <Badge variant="secondary" className="text-[9px]">需审批</Badge>}
                      {!action.rollback_supported && <Badge variant="destructive" className="text-[9px]">不可回滚</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{action.impact_summary}</p>
                    {action.skip_reason && (
                      <p className="text-xs text-red-600 mt-0.5">⚠ {action.skip_reason}</p>
                    )}
                  </div>

                  {/* 展开explanation */}
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setExpandedAction(isExpanded ? null : action.action_type)}>
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </Button>
                </div>

                {/* 展开详情 */}
                {isExpanded && (
                  <div className="px-3 pb-3 pt-0 border-t">
                    <div className="bg-muted/50 rounded-lg p-2 mt-2">
                      <p className="text-xs font-medium mb-1">为什么</p>
                      <p className="text-xs text-muted-foreground">{action.explanation}</p>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
                      <div><span className="text-muted-foreground">目标表: </span>{action.target_table}</div>
                      <div><span className="text-muted-foreground">创建待办: </span>{action.creates_todo ? '是' : '否'}</div>
                      <div><span className="text-muted-foreground">可回滚: </span>{action.rollback_supported ? '是' : '否'}</div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <Separator />

        {/* 汇总 */}
        <div className="flex items-center justify-between text-sm">
          <div className="flex gap-4">
            <span className="text-green-600">✅ 接受 {approvedActions.length}个</span>
            <span className="text-red-600">❌ 拒绝 {rejectedActions.length}个</span>
          </div>
          <p className="text-xs text-muted-foreground">确认后系统将执行已接受的操作</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => onConfirm(approvedActions, rejectedActions)} disabled={loading || approvedActions.length === 0}>
            {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
            确认执行 ({approvedActions.length}个操作)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
