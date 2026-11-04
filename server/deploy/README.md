# 部署（S7）

单机起步：一台云服务器 + docker compose（db / api / nginx）+ certbot 签证书。
技术方案 §3 的图就是这个结构，可水平扩到多实例（api 无状态、自己分配 rev）。

## 目录

```
deploy/
  nginx.conf            HTTPS 终止、按 IP 限流、X-Real-IP、2MB 请求体上限
  proxy_common.conf     反代公共头（两处 include，避免复制走样）
  backup.sh             每日 pg_dump + gzip + 保留 14 天（RPO ≤ 24h 靠它兑现）
  certs/                证书挂载目录（不入库）：fullchain.pem / privkey.pem
```

## 首次部署

```bash
# 0. 服务器上装 docker + compose 插件
# 1. 拉代码
git clone <repo> /srv/lianjie && cd /srv/lianjie/server

# 2. 写 .env（★ 不要提交；.gitignore 已排除）
cp .env.example .env
openssl rand -base64 48                  # 把结果填进 JWT_SECRET
# .env 里必须有这几项：
#   POSTGRES_PASSWORD=<强密码>
#   JWT_SECRET=<上面那串>
#   WECHAT_APPID / WECHAT_SECRET=<小程序后台 → 开发设置>
#   DEV_MODE=false
#   POSTGRES_USER=lianjie
#   POSTGRES_DB=lianjie

# 3. 先起 db + api，确认健康
docker compose up -d db api
curl -s localhost:8080/api/readyz        # 预期 {"ok":true}

# 4. 签证书（域名解析要先指到这台机器）
docker run --rm -v "$PWD/deploy/certs:/etc/letsencrypt/live/api.example.com" \
  -v "$PWD/deploy/certs:/certs" certbot/certbot certonly --standalone \
  -d api.example.com --agree-tos -m you@example.com --no-eff-email
# certbot 的输出结构是 live/<域名>/fullchain.pem，软链到 deploy/certs/ 下：
ln -sf /etc/letsencrypt/live/api.example.com/fullchain.pem deploy/certs/fullchain.pem
ln -sf /etc/letsencrypt/live/api.example.com/privkey.pem   deploy/certs/privkey.pem

# 5. 起 nginx
docker compose up -d nginx
curl -s https://api.example.com/api/healthz
```

## 小程序后台

`开发管理 → 开发设置 → 服务器域名 → request 合法域名` 填 `https://api.<域名>`。
不备案的话正式域名填不进去（开发/体验版可以勾「不校验合法域名」直连）。

## 每日备份

```bash
chmod +x deploy/backup.sh
crontab -e
15 3 * * * /srv/lianjie/server/deploy/backup.sh >> /var/log/lianjie-backup.log 2>&1
```

异地一份（强烈建议：服务器整机丢失时才有救）：

```bash
# /etc/default/lianjie-backup
OFFSITE_CMD='rclone copy "$FILE" oss:lianjie-backup/'
```

**恢复演练（R4，上线前必须真跑一次）**

```bash
zcat /srv/backup/lianjie/lianjie-20261110-0315.sql.gz | \
  docker exec -i lianjie-db psql -U lianjie -d lianjie
```

## 发版

```bash
git pull && docker compose up -d --build api
```

`server/store.go` 的建表是幂等的（`IF NOT EXISTS` + `pg_advisory_lock`），滚动发版不会打架。
改表只加列不删列（契约 §2）。

## 现在还没做的

- 监控告警（R3）：`/readyz` 接外部拨测、日志里 5xx 比例告警
- 备案（P0）：不备案正式版上不了线
- 证书自动续期（certbot renew 的 cron + nginx reload）
