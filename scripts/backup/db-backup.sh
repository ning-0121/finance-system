#!/usr/bin/env bash
# ============================================================
# 财务库每日备份(L2 异地转储)
# pg_dump 全库(结构+数据+RLS+函数)→ gzip → AES-256 加密 → 投递企业微信「财务备份群」机器人
# GitHub Actions 另把 *.enc 留成制品(90天)当第二副本。
# 需要环境变量:SUPABASE_DB_URL / BACKUP_ENC_KEY / WECOM_ROBOT_KEY
# 只读源库(pg_dump 不改数据);产物加密,明文绝不出仓/出机。
# ============================================================
set -uo pipefail
ROBOT="https://qyapi.weixin.qq.com/cgi-bin/webhook"

notify() {  # $1 = markdown 文本
  [ -n "${WECOM_ROBOT_KEY:-}" ] || return 0
  curl -s -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"markdown\",\"markdown\":{\"content\":\"$1\"}}" \
    "${ROBOT}/send?key=${WECOM_ROBOT_KEY}" >/dev/null || true
}
fail() { echo "✗ $1" >&2; notify "❌ **财务库备份失败**\n> ${1}\n> 时间: $(date -u +'%F %T') UTC\n请尽快查 GitHub Actions 日志。"; exit 1; }

# 0. 配置齐全才跑;缺则跳过(避免配置前的定时任务反复报错刷屏)
if [ -z "${SUPABASE_DB_URL:-}" ] || [ -z "${BACKUP_ENC_KEY:-}" ] || [ -z "${WECOM_ROBOT_KEY:-}" ]; then
  echo "⏸ 备份未配置:请在仓库 Settings → Secrets and variables → Actions 添加"
  echo "   SUPABASE_DB_URL / BACKUP_ENC_KEY / WECOM_ROBOT_KEY,添加后自动生效。本次跳过(不算失败)。"
  exit 0
fi

TS=$(date -u +%Y%m%d-%H%M%S)
RAW="finance-db-${TS}.sql.gz"
ENC="finance-db-${TS}.sql.gz.enc"

echo "① pg_dump 全库…"
pg_dump "$SUPABASE_DB_URL" --no-owner --no-privileges --clean --if-exists 2>dump.err | gzip -9 > "$RAW" \
  || fail "pg_dump 失败: $(tail -n3 dump.err 2>/dev/null | tr '\n' ' ')"
[ -s "$RAW" ] || fail "转储 0 字节,疑连接串错误或无权限"

SHA=$(sha256sum "$RAW" | cut -d' ' -f1)
RAWSZ=$(du -h "$RAW" | cut -f1)

echo "② AES-256 加密…"
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$RAW" -out "$ENC" -pass "pass:${BACKUP_ENC_KEY}" || fail "加密失败"
rm -f "$RAW" dump.err   # 明文转储用完即删,只留加密件
ENCSZ=$(du -h "$ENC" | cut -f1)
ENCBYTES=$(stat -c%s "$ENC" 2>/dev/null || wc -c <"$ENC")

# 企业微信机器人文件上限 20MB;超了就只留 GitHub 制品并告警(库很小,一般到不了)
if [ "$ENCBYTES" -gt 20000000 ]; then
  notify "⚠️ **备份已生成但超20MB**(加密后 ${ENCSZ}),企业微信群文件传不了。已留 GitHub Actions 制品(90天)。建议改用微盘/OSS 大文件通道。SHA256: \`${SHA}\`"
  echo "encrypted >20MB, kept as artifact only"; exit 0
fi

echo "③ 投递企业微信「财务备份群」…"
MEDIA_ID=$(curl -s -F "media=@${ENC};type=application/octet-stream" \
  "${ROBOT}/upload_media?key=${WECOM_ROBOT_KEY}&type=file" | jq -r '.media_id // empty')
[ -n "$MEDIA_ID" ] || fail "企业微信 media 上传失败(检查机器人 key / 群是否存在)"
curl -s -H 'Content-Type: application/json' \
  -d "{\"msgtype\":\"file\",\"file\":{\"media_id\":\"${MEDIA_ID}\"}}" \
  "${ROBOT}/send?key=${WECOM_ROBOT_KEY}" >/dev/null || fail "企业微信文件消息发送失败"

notify "✅ **财务库每日备份成功**\n> 文件: \`${ENC}\`\n> 原始 ${RAWSZ} / 加密 ${ENCSZ}\n> SHA256: \`${SHA}\`\n> 时间: $(date -u +'%F %T') UTC(北京 $(TZ=Asia/Shanghai date +'%F %T' 2>/dev/null || echo '+8'))\n> 已投递本群文件 + GitHub 制品(留90天)。恢复见仓库 scripts/backup/RESTORE-RUNBOOK.md"
echo "✓ 完成: $ENC ($ENCSZ)"
