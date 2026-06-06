# 回款流水层 · 运维说明（Receivable Payments Ops）

> 应收已从「累计字段」升级为 **流水明细 → 匹配关系 → projection 汇总** 的财务级模型。
> 原则：**回款流水是权威数据**；`budget_orders.ar_received_amount` 只是 projection/缓存。

---

## 1. 迁移文件清单

| 文件 | 作用 | 生产库状态 |
|---|---|---|
| `migrations/20260607_receivable_payments.sql` | 建表 + 约束 + 触发器 + 匹配/撤销/作废 RPC + 幂等索引 + 初版 RLS | ✅ 已执行 |
| `migrations/20260607_receivable_payments.down.sql` | 上者回滚 | 未执行（按需） |
| `migrations/20260608_receivable_role_enforcement.sql` | RPC 内置角色校验 + 收紧 RLS + 争议处理 RPC | ✅ 已执行 |
| `migrations/20260608_receivable_role_enforcement.down.sql` | 上者回滚（恢复宽松 RLS、删争议 RPC） | 未执行（按需） |
| `scripts/verify-receivable-ledger.mjs` | E2E 验收脚本（建测试单跑全流程、出报告、清理） | 验收工具 |

> 注：20260607 第一次执行前有过一版「旧字段 `deleted_at`」的半成品残留，已 `DROP TABLE ... CASCADE` 清掉后用正式版重建。当前生产库为正式版。

---

## 2. 每个迁移做了什么

### 20260607（模型层）
- 表 `receivable_payments`（回款流水）：金额原币/币种/汇率/金额¥、到账日、银行、流水号、来源(`manual/bank_receipt/wecom_file/ocr`)、`matched_status`、审计字段(`updated_*`/`voided_*`)。
- 表 `receivable_payment_allocations`（匹配分配，**权威已收来源**）：`receipt_id`、`budget_order_id`、`amount_cny`、`void` 字段。
- 外键：`allocations.receipt_id → receivable_payments` 与 `allocations.budget_order_id → budget_orders` 均 **ON DELETE RESTRICT**（不级联）；`receipts.budget_order_id` 仅 quick link（ON DELETE SET NULL）。
- 约束：`amount_original/exchange_rate/amount_cny > 0`；分配 `amount_cny > 0`、`amount_original >= 0`。
- 触发器：
  - `trg_alloc_no_over`（BEFORE）：**防超分配**——同一回款有效分配合计不得超过回款金额。
  - `trg_alloc_recalc`（AFTER）：分配变动后**自动重算** `matched_status`（disputed 不动）。
- 幂等：`uq_recv_pay_dedup` 部分唯一索引——`payment_reference` 非空时 `(customer_name,bank_account,received_at,amount_cny,payment_reference)` 不可重复。
- RPC：`allocate_receivable_payment` / `unallocate_receivable_payment` / `void_receivable_payment`（事务内校验 + 自动状态 + 回写 `ar_received_amount` projection + 写 `entity_timeline` 审计）。
- 内部函数：`_refresh_order_ar_projection(order)`、`_recalc_receipt_match(receipt)`。
- 初版 RLS：`TO authenticated`（试运行期，写操作暂开放）。

### 20260608（角色权威鉴权）
- `_app_role()`：取登录用户业务角色。
- 3 个 RPC 内置角色校验（见第 6 节）；新增 `set_receivable_dispute`（仅 admin）。
- 收紧 RLS：人人可查；**登记回款 INSERT 仅财务角色**；**分配表禁止直接写**（一切走 RPC）。
- 豁免：`auth.uid()` 为空（service role / 后台脚本）跳过角色门，便于验收与后台任务。

---

## 3. 哪些 SQL 已在生产库执行
- ✅ 20260607 正式版（建表/触发器/RPC/索引/RLS）
- ✅ 20260608（角色校验 + 收紧 RLS + 争议 RPC）
- ✅ E2E 脚本已对生产库实跑 **18/18 通过**（数据已自动清理）

---

## 4. 验证对象是否存在（Supabase SQL Editor，只读）

```sql
-- 表
SELECT to_regclass('public.receivable_payments') AS t1,
       to_regclass('public.receivable_payment_allocations') AS t2;
-- 函数 / RPC
SELECT proname FROM pg_proc WHERE proname IN
 ('allocate_receivable_payment','unallocate_receivable_payment','void_receivable_payment',
  'set_receivable_dispute','_app_role','_refresh_order_ar_projection','_recalc_receipt_match')
 ORDER BY 1;
-- 触发器
SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_alloc_no_over','trg_alloc_recalc');
-- RLS 策略（应：两表 SELECT 给 authenticated；receivable_payments 有按角色的 INSERT；分配表无 ins/upd/del）
SELECT tablename, policyname, cmd, roles FROM pg_policies
 WHERE tablename IN ('receivable_payments','receivable_payment_allocations') ORDER BY 1,3;
-- 幂等索引
SELECT indexname FROM pg_indexes WHERE indexname='uq_recv_pay_dedup';
```

---

## 5. 如何复跑 E2E
```bash
node scripts/verify-receivable-ledger.mjs
```
- 凭据：自动从 `.env.local` 读 `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`（service role 绕过 RLS，但**约束/触发器/RPC 照常生效**）。
- 预期输出：**18/18 通过** + 一份「金额/分配/projection/状态」报告。
- **会不会清理数据：会。** 脚本自建测试订单(`notes=E2E-RECV-TEST`)与测试回款(`E2E-PR-*`)，结束时自动 `delete` 清空，不留痕。若中途异常未清，手动删：先删这些 receipt 的 allocations，再删 receipts，最后删测试订单。

---

## 6. 角色权限矩阵

| 角色 | 登记回款/收款 | 匹配 | 撤销匹配 | 作废回款 | 核销/修正 | 处理争议(disputed) | 查看 |
|---|---|---|---|---|---|---|---|
| 业务员 sales / 采购 procurement / 其他 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅(只读) |
| 财务员 finance_staff | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ |
| 财务经理 finance_manager | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | ✅ |
| 财务负责人/管理员 admin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

- **两层保障**：UI 按角色显隐按钮（友好）；RPC + RLS 在 DB 层强制（权威，绕过 UI 也拦得住，返回 `FORBIDDEN`）。
- disputed 的**界面入口暂未开放**（DB 的 `set_receivable_dispute` 已就绪），按需再加。

---

## 7. 常见故障排查

| 现象 | 原因 / 处理 |
|---|---|
| **按钮不显示** | 当前账号角色不足（如业务员只读）。确认 `profiles.role`；财务员见登记/匹配，经理见撤销/作废。 |
| **RPC 报 FORBIDDEN** | 角色无权（预期）。需对应角色操作；或检查该用户 `profiles.role` 是否正确。 |
| **回款匹配不上 / 匹配下拉为空** | 匹配只列「同客户且未结清」的订单。多因**回款客户名与订单客户名不一致**——登记回款时客户名要与订单客户一致（下拉里选）。 |
| **OVER_ALLOCATION** | 分配合计超过回款金额——属正常拦截，减少本次匹配金额。 |
| **重复流水号被拦** | 命中 `uq_recv_pay_dedup`（同客户/银行/日期/金额/流水号已存在），非 bug。 |
| **projection(已收) 没更新** | 已收由分配汇总自动回写。检查：是否走了 RPC（不要直接改表）；订单 `exchange_rate` 是否为 0/空（会跳过回写）；刷新页面重载。历史订单无分配时回退显示 `ar_received_amount`。 |
| **登录用户看不到回款数据** | RLS 是 `TO authenticated`——必须**登录**访问；演示模式(anon)看不到回款表，属预期。 |

---

## 8. 回滚策略

- **可回滚**：执行对应 `.down.sql`。
  - `20260608.down`：恢复试运行期宽松 RLS、删 `set_receivable_dispute`（保留 `_app_role`，因 RPC 仍引用）。如需完全去除 RPC 内角色判断，重跑 `20260607` 的 RPC 段。
  - `20260607.down`：删两表 + 函数 + 触发器（**会丢失全部回款流水与匹配记录**，仅在确无生产数据时使用）。
- **不能直接 drop / hard delete**：
  - 分配表 `allocations` 对 `receivable_payments` 与 `budget_orders` 是 **RESTRICT**——不能在有分配时直接删回款或订单。
  - 作废用 **void（`voided_at`）**，不物理删——保留审计链。
  - **为什么不能 hard delete 财务流水**：回款/匹配是权威账实依据，任何金额变动都必须可追溯（谁、何时、为何）。物理删会破坏审计、对账与责任界定；一律用 void + 原因。

---

## 9. 生产使用注意事项

- **回款流水是权威数据**：订单「真实已收」= 该订单有效分配(`allocations.amount_cny`)之和。
- **`ar_received_amount` 只是 projection/cache**：由 RPC 自动回写，**不要手工直接改**该字段当权威。
- **匹配/撤销/作废必须留审计**：全部走 RPC（写 `entity_timeline` + void 审计字段）；禁止直接改表绕过。
- **普通业务员不得修改**：只读；写操作在 DB 层被 RLS/RPC 拦截。
- **录回款时客户名与订单一致**：便于自动建议匹配（同客户、金额接近）。
- **外币回款**：登记时填币种+汇率；金额¥为权威汇总口径，原币字段保留备查。
