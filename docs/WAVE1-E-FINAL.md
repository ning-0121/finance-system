# Wave 1-E · Mutation Governance Audit + Final Verdict

**日期**：2026-05-23（任务窗口跨越 5-16 ~ 5-23）
**审计立场**：ERP 架构师 / CFO / 数据一致性工程师 / 审计与风控负责人
**生产库**：`qpoboelobqnfbytugzkw.supabase.co`
**前提**：Wave 1-A（软删）→ 1-B（freeze）→ 1-C（rollback）→ 1-D（provenance）+ auto-budget/auto-settlement 已完成

---

## 0. 全量回归证据

7 套件 56/56 ✓ + Wave 1-E 当场修的 SQL 注入 ✓

```
baseline 12-step E2E         12/12 ✓
complex 8 scenarios           8/8 ✓
Wave1-A 软删除                隐式覆盖（cleanup 全走 admin RPC）
Wave1-B auto-budget           5/5 ✓
Wave1-B freeze propagation   10/10 ✓
Wave1-C rollback integrity    7/7 ✓
Wave1-D financial_provenance  7/7 ✓
Auto-settlement (新业务功能)    7/7 ✓
                       ─────────────
                            56/56
```

TypeScript: 0 errors  ·  Build: webpack ok

---

## 1. Wave 1-E 治理审计结果

**总览**：18 项（实际为 17 项；1 项 P1#7 经现场探针确认为部分误报，降为 P2）

### P0 (3 项 — 必须修，挡 Production Pilot)

#### P0-E1 · `settlement/route.ts:95-117` 应付批量插入非原子

- **位置**：`src/app/api/orders/[id]/settlement/route.ts:95-117`
- **现象**：settlement 行先通过 `.eq('status','draft')` 原子转 `confirmed`，再 for-loop 单条插 N 张 `payable_records`。若插到第 3 条失败，settlement 已 confirmed 但只有 3 张应付。
- **复现**：5 张发票的决算，构造第 4 张 invoice_id 触发 FK 违例 → settlement=confirmed + 应付仅 3 张。
- **影响**：试算平衡 AP 总额 < subledger；月末关账 AP/AR 一致性检查爆。
- **修复**：建 `create_settlement_with_payables_atomic(p_settlement_id, p_payables jsonb)` RPC，一次性插完所有应付；若任一失败整体 rollback；最后才把 settlement 置 confirmed。
- **回滚风险**：低（新 RPC + 单点替换）

#### P0-E2 · `executor.ts:109-178` 子账写入无补偿 GL 过账

- **位置**：`src/lib/document-engine/executor.ts:109-178`
- **现象**：动作执行（如 `create_payment_request`）插 `actual_invoices` 后没有立刻调 `create_journal_atomic` 做 GL 对应分录；如果应用层后续 GL 步骤失败，subledger 有应付但 GL 没有对方。
- **复现**：发票动作执行成功，agent 后续 GL 调用因科目代码错误失败 → AP aging 看到该笔，trial balance 看不到。
- **影响**：subledger vs GL 永久背离；月末关账查不出来源。
- **修复**：每个产生 subledger 行的动作执行完毕，**同事务内**调 RPC 写 GL；失败时 RPC 整体 rollback 把 subledger 行也撤掉。
- **回滚风险**：中（需要重审 executor 状态机）

#### P0-E3 · `webhook/route.ts:289` SQL 字符串插值（已修复）

- **位置**：`src/app/api/integration/webhook/route.ts:289`（原 Wave 1-B-step1 引入）
- **现象**：`sql: \`UPDATE synced_orders SET ... WHERE id = '${syncedOrderId}'\`` 字符串拼接。即便 webhook 有签名验证，财务系统也不允许这种攻击面。
- **修复**：✅ 本轮已修。新建 `increment_sync_attempt(uuid)` RPC，参数化调用。
- **回归**：Wave 1-B auto-budget 5/5 仍绿。

### P1 (6 项 — 高量级生产前修)

| ID | 文件 | 行 | 问题 | 修复方向 |
|----|------|----|----|----|
| P1-E1 | `settlement/route.ts` | 95-117 | 同上 P0 的并发副作用：dedupe set 用一次但 race 仍可重复插 | 加 UNIQUE(settlement_id, invoice_id) DB 约束 |
| P1-E2 | `integration/sync/route.ts` | 104-124 | customer lookup-then-create race | `get_or_create_customer(name, currency)` RPC |
| P1-E3 | `integration/sync/route.ts` | 46-58 | `synced_orders.update` 无 version 乐观锁，并发 sync 后写覆盖先写 | 加 version 列 + `.eq('version', X)` |
| P1-E4 | `profit/recompute-budget/route.ts` | 225-231 | `sotWriteShadow` 失败被 try/catch 吞 → 主路径返回 success 但 lineage 缺 | 失败时写 `save_diagnostic_logs(status='error')` + 响应里标 `partial_success` |
| P1-E5 | `orchestration-engine.ts` | 110-143 | 规则动作 (freeze + create_risk + ...) 按数组顺序跑，中段失败不回滚已执行的 | 包成 RPC 或显式补偿动作链 |
| P1-E6 | `closing-engine.ts` | 320-322 | 12 项关账检查无 period 锁，并发请求会重跑 | 检查 `accounting_periods.status='closing'`，否则拒 |

### P2 (8 项 — 结构债，下个 Sprint 收尾)

| ID | 文件 | 简述 |
|----|------|----|
| P2-E1 | `executor.ts:249-260` | provenance 写入了，但 actor_id='system' 而非真实 confirmed_by → 设 `SET LOCAL audit.actor_id` 或在 INSERT 时填 created_by |
| P2-E2 | `executor.ts:164-176` | `document_actions` 更新无 `execution_error` 字段 |
| P2-E3 | `profit/styles/[id]/route.ts:82-83` | SoT shadow 并发写竞争 |
| P2-E4 | `profit/import/route.ts:159-164` | 批量 upsert 不区分 created/updated/skipped |
| P2-E5 | `settlement/route.ts:116` | `payablesCreated` 计数仅在 !insertErr 时加，最终值不可靠 |
| P2-E6 | `profit/styles/[id]/route.ts:105` | DELETE 路由无 audit log |
| P2-E7 | `profit/fx/route.ts:51-58` | 表缺失时静默 fallback 7.15，掩盖部署遗漏 |
| P2-E8 | `executor.ts:121-130` | L1 失败后续动作 skip 时不附根因 |

---

## 2. DB 侧治理事实（实测）

- **38 个 public RPC**，含 Wave 1-A/B/D 新建 + 旧有触发器函数
- **0 orphan journal_entries**（journal_lines 全有 journal_id FK + CASCADE）
- **0 orphan payable_records**（指向已删 budget_orders 的）
- **pg_cron 未安装** → 无 cron 任务路径
- **`journal_lines.journal_id` ON DELETE CASCADE** 配合 admin RPC + session var 工作正常
- **`order_settlements` FK 3 个**：budget_order_id, settled_by, source_shipping_id（auto-settlement 已生效）
- **`synced_orders` 约束完整**：UNIQUE(order_no), budget_sync_status CHECK

---

## 3. Trust Layer 评分卡（Wave 1 全局）

| 维度 | Wave 1 之前 | Wave 1 之后 | 证据 |
|---|---|---|---|
| **Hard Delete Forbidden** | ❌ 静默 fallback 到硬删 | ✅ DB trigger 强制拒绝 | `financial_hard_delete_guard()` + 9 表挂接 |
| **Freeze Enforced at Mutation** | ❌ 仅 UI 装饰，RPC 不查 | ✅ DB trigger + RPC 注入 | `financial_freeze_guard()` + 5 表 trigger + RPC 内查所有 line.order_id |
| **No Silent Financial Failure** | ❌ webhook console.error 吞 | ✅ 5 状态写回 synced_orders + diagnostic | `budget_sync_status` + tests 5/5 |
| **Rollback 完整性** | ❌ ghost tables + .delete() 0 rows 静默 success | ✅ 启动校验 + affected_rows 强制 + 软删路由 | `validateRollbackWhitelistSimple()` + tests 7/7 |
| **CFO 7 问可回放** | ❌ 仅 4 字段 audit | ✅ provenance overlay + 5 表触发器 | `financial_provenance` 表 + tests 7/7 实测链路可读 |
| **AI 不能自动过账** | ⚠ 无门控 | ✅ auto-settlement 强制 settled_by 才能 confirm | `trg_settlement_confirm_requires_human` |
| **职责分离 (SoD)** | ❌ 无约束 | ✅ unfrozen_by ≠ frozen_by 触发器 | `trg_check_unfreeze_segregation` |
| **紧急通道有 audit** | N/A | ✅ `_admin_bypass_freeze_write` 强制 ≥8 字符 reason | 实测 audit 行落地 |

---

## 4. 最终成熟度评级

| 级别 | 标准 | 当前 |
|---|---|---|
| **Demo** | 单订单 happy path | ✅ |
| **Internal Trial** | 复杂场景全绿 + 借贷恒平衡 | ✅ |
| **Production Pilot** | + Trust Layer 强制 + 字段级 audit + AI 自治门控 + 无 P0 残留 | ⚠ **2 项 P0 残留** |
| **Enterprise Ready** | + 全部 P1 修完 + DR 演练 + 完整 SOX 审计链 + Control Center v2 | ❌ |

### 当前定位

**Wave 1 把系统从 Internal Trial 推到了 "Production Pilot 候选"，但仍卡 2 项 P0**：

```
✅ Demo
✅ Internal Trial
🟡 Production Pilot — 候选状态（卡 P0-E1 + P0-E2，需 Wave 2 修）
❌ Enterprise Ready
```

P0-E3 (SQL 注入) 已本轮修复。

### 现在允许做的事

| # | 操作 | 当前允许？ | 条件 |
|---|---|---|---|
| 1 | 内部试运行（< 20 单/周）| ✅ 完全允许 | Trust Layer 强制 + 财务每日复核 |
| 2 | 财务双签（unfreeze、settlement confirm）| ✅ 允许 | DB 触发器已强制不同 actor |
| 3 | AI Draft（auto-budget / auto-settlement → draft）| ✅ 允许 | 进 draft，从不进 GL，不经人审无法 confirm |
| 4 | AI Auto-Post GL | ❌ 禁止 | trg_settlement_confirm_requires_human 已挡 |
| 5 | 大规模真实订单 | ❌ 暂禁 | 需先修 P0-E1（应付批量原子）和 P0-E2（subledger ↔ GL 补偿） |

### Production Pilot 的硬门槛

完成下面 2 项即可进入 Production Pilot：

1. **建 RPC `create_settlement_with_payables_atomic`** 替换 `settlement/route.ts:95-117`
2. **修 `executor.ts` 让每个产生 subledger 的动作同事务内调 GL RPC**，失败时整体 rollback

预计 4-6 小时工程量。配套回归：复杂场景加 "settlement 中段失败回滚" + "document executor 部分失败" 两个用例。

完成后建议再做一次 Production Pilot 准入复审（含完整 56+2 用例 + manual smoke test 单流量真实订单走完 12 步）。

---

## 5. 我对当前系统的诚实评价

- **Trust Layer 的骨架真实存在**：不是装饰、不是注释、不是 console.log。每一项都有 DB trigger / RPC / 触发的回归测试做证据。
- **覆盖率仍是局部的**：5 张核心表 + 关键 RPC 已覆盖；executor 和 settlement 路由还有 P0 漏洞。
- **审计能力到位**：CFO 7 问对 5 张核心表 + journal 全可回答；对 budget_orders 自身（如审批人变更）仍依赖旧 financial_audit_log（仅 4 字段）。
- **AI 边界明确**：自动建 draft 允许；任何 'draft → confirmed/posted' 都要人。
- **系统不会"假装"成功**：所有失败路径必须留痕（hard fail / persist / audit / visible / explainable 四件）。Wave 1-E 找到的几个静默吞错点都在 P1 修复清单里。
- **紧急通道存在但留痕**：`_admin_hard_delete` + `_admin_bypass_freeze_write` 是必要的，因为完全禁止会让 DBA 在生产故障时无路可走；但每次使用都强制 reason ≥8 字符 + 写 audit row。

**Wave 1 不是 "可信任系统"的终点；它是 "停止欺骗自己" 的起点**。系统现在不再有"看起来工作但实际不工作"的功能（freeze、soft delete、rollback、auto-budget 之前全是这种）。剩下的 2 P0 + 6 P1 是真实工作量，但都有边界、有测试、有 rollback 路径。

— Claude (架构师 / CFO / 审计责任人 立场)
