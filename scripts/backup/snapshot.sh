#!/usr/bin/env bash
# ============================================================
# L5 变更前一键快照(本地手动)——跑迁移/批量改账之前先存一份。
# 用法:
#   export SUPABASE_DB_URL='postgresql://postgres.xxx:PWD@...pooler.supabase.com:5432/postgres'
#   export BACKUP_ENC_KEY='你的加密口令'   # 与每日备份同一口令,恢复才通用
#   bash scripts/backup/snapshot.sh "改账前-货代补录"
# 产物:./backups/finance-db-<时间>-<标签>.sql.gz.enc (已加密,勿提交入仓)
# 只读源库;明文用完即删。
# ============================================================
set -euo pipefail
: "${SUPABASE_DB_URL:?请先 export SUPABASE_DB_URL(Supabase 后台 Database→Connection string→URI,含密码)}"
: "${BACKUP_ENC_KEY:?请先 export BACKUP_ENC_KEY(加密口令,须与每日备份一致)}"
LABEL="${1:-manual}"
DIR="./backups"; mkdir -p "$DIR"
TS=$(date -u +%Y%m%d-%H%M%S)
RAW="${DIR}/finance-db-${TS}-${LABEL}.sql.gz"
ENC="${RAW}.enc"

echo "① pg_dump…"
pg_dump "$SUPABASE_DB_URL" --no-owner --no-privileges --clean --if-exists | gzip -9 > "$RAW"
[ -s "$RAW" ] || { echo "✗ 转储为空,检查连接串"; rm -f "$RAW"; exit 1; }
echo "② 加密…"
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$RAW" -out "$ENC" -pass "pass:${BACKUP_ENC_KEY}"
SHA=$(shasum -a256 "$RAW" 2>/dev/null | cut -d' ' -f1 || sha256sum "$RAW" | cut -d' ' -f1)
rm -f "$RAW"
echo "✓ 快照: $ENC  ($(du -h "$ENC" | cut -f1))  SHA256(明文)=${SHA}"
echo "  恢复见 scripts/backup/RESTORE-RUNBOOK.md"
