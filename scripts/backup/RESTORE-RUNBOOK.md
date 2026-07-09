# 财务系统 备份与恢复手册(Runbook)

> 生产资金账。恢复是高压操作,照本手册一步步来。所有备份**加密**,没有加密口令 `BACKUP_ENC_KEY` 谁也解不开——**口令必须离线另存**(见文末)。

## 备份长这样(纵深防御,四层)

| 层 | 是什么 | 在哪 | 频率/保留 | 恢复用途 |
|---|---|---|---|---|
| **L1 PITR** | Supabase 时点恢复 | Supabase 后台 | 连续,7–28 天 | 崩溃/误删/脏写,**回到任意一秒**(首选) |
| **L2 每日转储** | 加密全库 dump | 企业微信备份群 + GitHub 制品(90天) | 每日 | Supabase 账号/项目整个没了、要迁库 |
| **L3 月度冷档** | 每月留一份 | 同上(长留) | 每月,建议 24 月 | 合规/审计追溯 |
| **L5 变更前快照** | 手动 dump | 本地 `./backups` | 按需 | 改账/迁移改错,秒回滚 |

## 场景 A:误删/改错/脏写(数据还在,想回到某个时间点)—— 用 PITR
1. Supabase 后台 → 项目 → **Database → Backups → Point in Time**。
2. 选目标时间(问题发生**之前**几分钟),Restore。
3. ⚠️ PITR 会把**整库**回到该时点,该时点之后的所有改动都会丢——恢复前先确认没有需要保留的新数据;必要时先跑一次 L5 快照留底。
4. 恢复后核对关键表行数、几张近期订单是否正常。

## 场景 B:Supabase 项目/账号没了,要在新库重建 —— 用 L2/L3 加密转储
前提:装好 `psql`/`pg_dump`(PG17)、`openssl`;拿到某份 `finance-db-YYYYMMDD-*.sql.gz.enc` 和加密口令。

```bash
# 1) 解密 → 解压
openssl enc -d -aes-256-cbc -pbkdf2 -in finance-db-20260709-020000.sql.gz.enc \
  -out restore.sql.gz -pass 'pass:你的BACKUP_ENC_KEY'
gunzip restore.sql.gz            # 得到 restore.sql

# 2) 建一个空的目标库(新 Supabase 项目 或 本地 PG),拿到它的连接串 TARGET_URL
#    本地示例:createdb finance_restore

# 3) 灌入(转储用了 --clean --if-exists,可覆盖式恢复)
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f restore.sql

# 4) 校验:比对行数
psql "$TARGET_URL" -c "select count(*) from cost_items;"   # 与备份当日应一致
```
恢复后:改应用的 `NEXT_PUBLIC_SUPABASE_URL` / service key 指向新库,重新部署 Vercel。

## 场景 C:改账前留底(跑迁移/批量订正之前)
```bash
export SUPABASE_DB_URL='...(Database→Connection string→URI,含密码)'
export BACKUP_ENC_KEY='...(与每日备份同一口令)'
bash scripts/backup/snapshot.sh "本次改动标签"
# 改错了 → 按场景 B 用这份快照恢复
```

## 每月必做:恢复演练(否则备份=心理安慰)
1. 取最新 L2 加密转储,按**场景 B** 恢复到一个**临时** Supabase 项目(或本地 PG)。
2. 比对 `budget_orders / cost_items / journal_lines` 行数与备份当日一致;抽查 2 张订单金额正常。
3. 记一行"YYYY-MM-DD 演练通过"。用完删掉临时库。

## RPO / RTO(目标)
- **RPO(最多丢多少)**:有 PITR ≈ 秒级;仅靠 L2 每日 ≈ 24 小时。
- **RTO(多久能恢复)**:PITR 约 10–30 分钟;从转储重建约 1–2 小时。

## 加密口令托管(生死攸关)
- `BACKUP_ENC_KEY` **一旦丢失,所有加密备份永久打不开**。
- 存放:① GitHub Actions Secret(自动备份用);② **离线另存至少两处**(密码管理器 + 纸质/保险柜),不要只存在系统里、也不要进代码仓。
- 定期(如每季)确认口令仍能解开最新一份备份(即上面的恢复演练)。

## Secrets 清单(GitHub 仓库 → Settings → Secrets and variables → Actions)
| 名称 | 值 |
|---|---|
| `SUPABASE_DB_URL` | Supabase→Project Settings→Database→Connection string→**URI**(会话/直连 5432,含密码;可加 `?sslmode=require`) |
| `BACKUP_ENC_KEY` | 自定义强口令(≥24位随机)。**离线另存!** |
| `WECOM_ROBOT_KEY` | 企业微信「财务备份群」群机器人 webhook 里 `key=` 后面那串 |
