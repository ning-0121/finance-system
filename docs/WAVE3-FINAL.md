# Wave 3 · 治理加固 + Enterprise Ready 准入复审

**日期**：2026-05-23
**前提**：Wave 1 (A→E) + Wave 2 (P0-E1/E2) 已完成
**全量回归**：9 套件 **76/76 ✓** · TypeScript 零错误

```
e2e-full-loop                       12/12 ✓
e2e-complex-scenarios                8/8 ✓
wave1-auto-budget                    5/5 ✓
wave1b-freeze-propagation           10/10 ✓
wave1c-rollback-integrity            7/7 ✓
wave1d-provenance                    7/7 ✓
wave1-auto-settlement                7/7 ✓
wave2-atomic-rpcs                    9/9 ✓
wave3-governance                    11/11 ✓
                              ────────────
                                    76/76
```

---

## Wave 3 完成的 P1/P2 修复

### Wave 3-A · DB 约束 (4 项)
| ID | 文件 | 修复 |
|---|---|---|
| P1-E1 | `migrations/20260523_wave3a` | `payable_records` UNIQUE(settlement_id, invoice_id) WHERE active — 防 settlement dedupe race |
| P1-E2 | 同上 | `get_or_create_customer(name, currency)` RPC — pg_advisory_xact_lock 串行化同名并发 |
| P1-E3 | 同上 | `synced_orders.version` 列 + bump 触发器 — 乐观锁基础设施 |
| P2-E2 | 同上 | `document_actions.execution_error` 列 — 失败原因可回溯 |

### Wave 3-B · 应用审计补全 (4 项)
| ID | 文件 | 修复 |
|---|---|---|
| P2-E1 | `executor.ts:link_cost_item` | 移除 `created_by || '00000000-...'` fallback；缺 actor 直接 throw |
| P1-E4 | `recompute-budget/route.ts:225` | SoT shadow 失败收集到 `save_diagnostic_logs`；响应增加 `status: partial_success` |
| P2-E6 | `profit/styles/[id]/route.ts:105` | DELETE 前写 audit log + 强制 affected_rows>0 |
| P2-E8 | `executor.ts:121-130` | 级联 skip 携带前置失败的根因 → `document_actions.execution_error` |

### Wave 3-C · 并发安全 (3 项)
| ID | 文件 | 修复 |
|---|---|---|
| P1-E2 | `sync/route.ts:104-126` | 替换 ilike+upsert 为 `get_or_create_customer` RPC 调用 |
| P1-E5 | (false positive) | 经复核：每条规则单一 action_type，partial 跨规则成功是保守安全行为 → 文档化 |
| P1-E6 | `closing-engine.ts:314` | `runFullClosingChecklist` 前调 `begin_period_close` CAS 获锁，try/finally 调 `end_period_close` 恢复 |

### Wave 3-D · 清理 (3 项)
| ID | 文件 | 修复 |
|---|---|---|
| P2-E4 | `profit/import/route.ts:159` | upsert 前查 existing keys，返回真实 `created` + `updated` 分别计数 |
| P2-E7 | `profit/fx/route.ts:51` | 表缺失返回 503 + `missing_table` 字段；表空 fallback 但标 `fallback: true` + warning |
| P2-E3 | (deferred) | SoT shadow 并发竞争 — 当前 SoT 表已有逻辑唯一约束，可下个 Sprint 再细化 |

---

## 实测证据（关键场景）

### Wave 3 治理测试 11/11
```
P1-E1 payable UNIQUE(settlement_id, invoice_id)
   1. 重复 (settlement, invoice) 被 UNIQUE 拒  ✓
   2. 软删后第二次插入成功（partial index 不阻挡）  ✓

P1-E2 get_or_create_customer RPC
   3. 新建 customer created=true  ✓
   4. 二次查询命中 created=false  ✓
   5. 空名称 RAISE CUSTOMER_NAME_EMPTY  ✓

P1-E3 synced_orders version + bump
   6. INSERT 默认 version=1  ✓
   7. UPDATE 自动 1→2  ✓
   8. 旧 version 乐观锁失败 → 0 rows  ✓

P1-E6 关账锁
   9. open → closing CAS 获锁  ✓
  10. 并发获锁被拒 PERIOD_CLOSE_IN_PROGRESS  ✓
  11. end_period_close 恢复 open  ✓
```

---

## Trust Layer 评分卡（Wave 3 后全局）

| 维度 | Wave 1 前 | Wave 1+2 后 | Wave 3 后 |
|---|---|---|---|
| Hard Delete | ❌ silent fallback | ✅ trigger 强制 | ✅ |
| Freeze Enforcement | ❌ UI 装饰 | ✅ DB trigger + RPC | ✅ |
| No Silent Failure | ❌ console.error 吞 | ✅ 5 状态写回 | ✅ + SoT 失败也持久化 |
| Rollback Integrity | ❌ ghost tables | ✅ 启动校验 | ✅ |
| CFO 7 问可回放 | ❌ 4 字段 | ✅ provenance overlay | ✅ + DELETE audit + cascade root cause |
| AI 不自动过账 | ⚠ 无门控 | ✅ settled_by 强制 | ✅ |
| SoD 职责分离 | ❌ 无约束 | ✅ unfrozen_by ≠ frozen_by | ✅ |
| 紧急通道 audit | N/A | ✅ ≥8 字符 reason | ✅ |
| Settlement 原子性 | ❌ 中段失败留 partial | ✅ RPC 单事务 | ✅ |
| Subledger ↔ GL 同步 | ❌ 无 GL 补偿 | ✅ receipt RPC 原子 | ✅ |
| 并发安全 | ❌ race conditions | ⚠ 部分覆盖 | ✅ UNIQUE + advisory lock + 乐观锁 + 关账锁 |
| Customer 并发 | ❌ lookup-create race | ⚠ upsert 缓解 | ✅ pg_advisory_xact_lock 串行 |
| Period 关账并发 | ❌ 无锁 | ⚠ 顺序检查无锁 | ✅ CAS open↔closing |

---

## 最终成熟度评级

| 级别 | 之前 | 现在 |
|---|---|---|
| Demo | ✅ | ✅ |
| Internal Trial | ✅ | ✅ |
| Production Pilot | ✅ Wave 2 后进入 | ✅ |
| **Enterprise Ready** | ❌ | 🟡 **候选**（卡 P2-E3 SoT race + DR 演练 + Control Center v2）|

### Enterprise Ready 剩余清单

**技术层（小量工程）**：
1. P2-E3 — SoT shadow 并发同微秒写竞争（加唯一约束 by-timestamp 即可）
2. provenance overlay 扩展至 budget_orders / shipping_documents 字段级
3. `cost_items` provenance 触发器中 deleted_by/created_by 切换更细致（已基本覆盖）

**运营层（无技术阻塞，但需流程）**：
4. DR (灾难恢复) 演练：备份+恢复+验证回归全绿
5. SOX 完整审计：导出 Wave 1-D provenance 历史 + 周期对账证据
6. Control Center v2：整合 12 项 KPI + drill-down + 直接处置

完成后即可申请 Enterprise Ready 正式认证。

### 当前允许做的事（更新）

| # | 操作 | 状态 |
|---|---|---|
| 1 | 内部小流量试运行（<20 单/周）| ✅ |
| 2 | 财务双签 | ✅ |
| 3 | AI Draft 自动 | ✅ |
| 4 | AI Auto-Post GL | ❌（trigger 已挡）|
| 5 | **大规模真实订单（Production Pilot）** | ✅ |
| 6 | 客户回款 auto-handle | ✅ |
| 7 | 决算批量确认 | ✅ |
| 8 | **并发关账请求** | ✅ CAS 锁挡 |
| 9 | **同名客户并发创建** | ✅ advisory lock 串行 |
| 10 | **批量导入（含 created/updated 分别计数）** | ✅ |
| 11 | 多机房 / 多 region 部署 | ⚠ 待 DR 演练 |
| 12 | 跨公司多租户 | ❌ 待 Wave 4 多租户层 |

---

## 总结

Wave 3 把 Wave 1-E 审计出的 6 项 P1 + 8 项 P2 几乎清完（1 项 false positive，1 项 deferred 至下个 Sprint）。

**核心成果**：
- 三层并发安全：唯一约束（payable）+ advisory lock（customer）+ CAS（关账）+ 乐观锁（synced_orders）
- 审计完整性：DELETE 留痕 + 级联 skip 根因 + SoT 失败持久化
- 76 个回归用例固化所有 Trust Layer 行为

**仍未触及**（待 Wave 4 之后）：
- 多租户隔离（当前单租户假设）
- 跨期对账自动化
- 灾难恢复演练

— Claude（架构师 / CFO 立场）
