#!/bin/bash
# 每日备份：pg_dump 全库 → gzip → 保留 14 天
#
# 为什么要它：技术方案 §5.3 承诺 RPO ≤ 24h。没有这个脚本，"每日备份"只是文档里一句话。
#
# 装法（服务器上）：
#   crontab -e
#   15 3 * * * /srv/lianjie/server/deploy/backup.sh >> /var/log/lianjie-backup.log 2>&1
#
# 环境变量（放 /etc/default/lianjie-backup 或直接改下面）：
#   BACKUP_DIR     备份落盘目录（默认 /srv/backup/lianjie）
#   KEEP_DAYS      保留天数（默认 14）
#   PGDATA_VOLUME  docker volume 名（默认 lianjie_pgdata，compose 项目名 lianjie 时）
#   OFFSITE_CMD    异地备份命令，留空则跳过。例如：rclone copy "$FILE" oss:lianjie-backup/

set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/srv/backup/lianjie}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DB_USER="${DB_USER:-lianjie}"
DB_NAME="${DB_NAME:-lianjie}"
CONTAINER="${CONTAINER:-lianjie-db-1}"
OFFSITE_CMD="${OFFSITE_CMD:-}"

STAMP=$(date +%Y%m%d-%H%M)
FILE="$BACKUP_DIR/$DB_NAME-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR" || { echo "建目录失败：$BACKUP_DIR"; exit 1; }

echo "[$(date '+%F %T')] 开始备份 $DB_NAME"

# 用自定义格式（-Fc）比 plain SQL 更适合恢复单表，但恢复命令稍有不同；
# 这里用 plain + gzip：恢复就是 zcat | psql，出问题时少一个坑。
if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
     | gzip -6 > "$FILE.part"; then
  echo "[$(date '+%F %T')] 备份失败，保留现场：$FILE.part"
  exit 1
fi
mv "$FILE.part" "$FILE"

SIZE=$(du -h "$FILE" | cut -f1)
echo "[$(date '+%F %T')] 完成：$FILE（$SIZE）"

# 异地一份（服务端全丢时才用得上；本地全量还能从各设备重新上传，见技术方案 §5.3）
if [ -n "$OFFSITE_CMD" ]; then
  if eval "$OFFSITE_CMD"; then
    echo "[$(date '+%F %T')] 异地备份完成"
  else
    echo "[$(date '+%F %T')] 异地备份失败（本地备份仍然有效）"
  fi
fi

# 只留最近 KEEP_DAYS 天
find "$BACKUP_DIR" -name "$DB_NAME-*.sql.gz" -mtime +"$KEEP_DAYS" -print -delete \
  | sed 's/^/[清理] /'

exit 0
