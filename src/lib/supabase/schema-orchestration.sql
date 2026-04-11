-- ============================================================
-- AI财务Operating System — 编排任务 + 自动化规则
-- ============================================================

-- 1. 智能任务表
CREATE TABLE IF NOT EXISTS public.orchestration_tasks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical', 'urgent')),
  source_module text NOT NULL,
  source_entity_type text,
  source_entity_id text,
  explanation text NOT NULL,
  assignee_role text NOT NULL DEFAULT 'finance_staff',
  escalation_role text DEFAULT 'finance_manager',
  due_date timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'blocked', 'escalated', 'resolved', 'closed', 'cancelled')),
  blocked_reason text,
  suggested_action text,
  action_href text,
  created_by_rule boolean DEFAULT false,
  rule_id uuid,
  resolved_by uuid REFERENCES public.profiles(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. 自动化规则表
CREATE TABLE IF NOT EXISTS public.automation_rules (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  description text,
  priority integer NOT NULL DEFAULT 50,
  is_enabled boolean NOT NULL DEFAULT true,
  condition_type text NOT NULL,
  condition_config jsonb NOT NULL DEFAULT '{}',
  action_type text NOT NULL,
  action_config jsonb NOT NULL DEFAULT '{}',
  cooldown_minutes integer DEFAULT 60,
  last_triggered_at timestamptz,
  trigger_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_tasks_status ON public.orchestration_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_severity ON public.orchestration_tasks(severity);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON public.orchestration_tasks(assignee_role);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON public.orchestration_tasks(source_module, source_entity_id);
CREATE INDEX IF NOT EXISTS idx_rules_enabled ON public.automation_rules(is_enabled, priority);

-- RLS
ALTER TABLE public.orchestration_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tasks_all" ON public.orchestration_tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "rules_all" ON public.automation_rules FOR ALL USING (true) WITH CHECK (true);

-- 3. 预置15条核心规则
INSERT INTO public.automation_rules (name, description, priority, condition_type, condition_config, action_type, action_config) VALUES

-- 信任规则
('低信任自动冻结', '信任等级降至T0/T1时自动冻结实体', 10,
 'trust_low', '{"threshold_level": "T1"}',
 'freeze_entity', '{"freeze_type": "auto_trust", "reason": "信任等级过低，自动冻结"}'),

('信任降级创建任务', '信任降级时创建跟踪任务', 20,
 'trust_low', '{"threshold_level": "T2"}',
 'create_task', '{"severity": "warning", "assignee_role": "finance_manager", "title_template": "信任降级: {entity_name} 降至 {trust_level}"}'),

-- 利润规则
('低毛利率预警', '订单毛利率低于10%自动创建稽核任务', 15,
 'margin_low', '{"threshold": 10}',
 'create_task', '{"severity": "warning", "assignee_role": "finance_staff", "title_template": "低毛利率订单: {order_no} ({margin}%)"}'),

('亏损订单紧急通知', '订单亏损时紧急通知财务总监', 5,
 'margin_low', '{"threshold": 0}',
 'create_task', '{"severity": "critical", "assignee_role": "finance_manager", "title_template": "亏损订单: {order_no} 利润 ¥{profit}"}'),

-- 回款规则
('回款超期30天催收', '应收超期30天创建催收任务', 25,
 'overdue_ar', '{"threshold_days": 30}',
 'create_task', '{"severity": "warning", "assignee_role": "finance_staff", "title_template": "回款超期: {customer} {order_no} 超{overdue_days}天"}'),

('回款超期60天升级', '应收超期60天升级审批', 10,
 'overdue_ar', '{"threshold_days": 60}',
 'create_task', '{"severity": "critical", "assignee_role": "finance_manager", "title_template": "回款严重超期: {customer} 超{overdue_days}天 ¥{amount}"}'),

-- 审批规则
('阻塞动作超时升级', '动作阻塞超48小时自动升级', 15,
 'blocked_timeout', '{"threshold_hours": 48}',
 'create_task', '{"severity": "warning", "assignee_role": "finance_manager", "title_template": "阻塞超时: {action_type} 已等待{hours}小时"}'),

-- 回滚规则
('高频回滚降信任', '同一实体30天内回滚超3次降低信任', 20,
 'rollback_high', '{"threshold_count": 3, "period_days": 30}',
 'downgrade_trust', '{"reason": "高频回滚，自动降级信任"}'),

-- 稽核规则
('严重异常紧急通知', '稽核发现严重异常立即创建任务', 5,
 'audit_critical', '{}',
 'create_task', '{"severity": "urgent", "assignee_role": "finance_manager", "title_template": "稽核异常: {finding_title}"}'),

-- 月结规则
('月结超时提醒', '月结检查未完成超过月底前3天', 30,
 'closing_incomplete', '{"days_before_end": 3}',
 'create_task', '{"severity": "warning", "assignee_role": "finance_manager", "title_template": "月结未完成: {period} 还有{pending}项待处理"}'),

-- 现金流规则
('现金流缺口预警', '预测现金流缺口超5万', 10,
 'cashflow_gap', '{"threshold": -50000}',
 'create_task', '{"severity": "critical", "assignee_role": "admin", "title_template": "现金流预警: 预计缺口 ¥{gap}"}'),

-- 供应商规则
('高风险供应商审批升级', '高风险供应商付款需要老板审批', 15,
 'supplier_risk', '{"threshold_level": "D"}',
 'create_task', '{"severity": "warning", "assignee_role": "admin", "title_template": "高风险供应商: {supplier_name} 等级{risk_level}"}'),

-- 重复付款规则
('重复付款自动冻结', '检测到重复付款自动冻结供应商', 5,
 'duplicate_payment', '{}',
 'freeze_entity', '{"freeze_type": "auto_audit", "reason": "检测到重复付款，自动冻结"}'),

-- 任务超时规则
('任务超时自动升级', '任务超过due_date未处理自动升级', 15,
 'task_overdue', '{}',
 'escalate_task', '{}'),

-- 文档识别规则
('OCR低置信度人工确认', 'OCR置信度低于70%暂停自动执行', 30,
 'ocr_low_confidence', '{"threshold": 70}',
 'create_task', '{"severity": "info", "assignee_role": "finance_staff", "title_template": "OCR需人工确认: {file_name} 置信度{confidence}%"}')

ON CONFLICT DO NOTHING;
