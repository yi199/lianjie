package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

const devJWTSecret = "dev-secret-change-me"

type config struct {
	addr         string
	databaseURL  string
	dbMaxConns   int32
	wechatAppID  string
	wechatSecret string
	jwtSecret    []byte
	devMode      bool
	tokenTTL     time.Duration
	loc          *time.Location
}

func loadConfig() (config, error) {
	c := config{
		addr:         getenv("ADDR", ":8080"),
		databaseURL:  os.Getenv("DATABASE_URL"),
		wechatAppID:  os.Getenv("WECHAT_APPID"),
		wechatSecret: os.Getenv("WECHAT_SECRET"),
		jwtSecret:    []byte(getenv("JWT_SECRET", devJWTSecret)),
		devMode:      getenv("DEV_MODE", "false") == "true",
		tokenTTL:     30 * 24 * time.Hour,
	}

	if c.databaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL 未设置")
	}

	// 连接池上限：单实例 20 足够（一次同步只占连接几毫秒）。
	// 多实例时注意 实例数 × DB_MAX_CONNS 不要超过 Postgres 的 max_connections（默认 100）。
	n, err := strconv.Atoi(getenv("DB_MAX_CONNS", "20"))
	if err != nil || n < 1 {
		return c, fmt.Errorf("DB_MAX_CONNS 必须是正整数")
	}
	c.dbMaxConns = int32(n)

	// 「今天」是自然日概念，服务器必须有一个明确时区，否则 streak 在跨零点时会错
	loc, err := time.LoadLocation(getenv("TZ_NAME", "Asia/Shanghai"))
	if err != nil {
		return c, fmt.Errorf("TZ_NAME 无效: %w", err)
	}
	c.loc = loc

	// 生产环境的两道保险：漏配任何一个都拒绝启动，而不是带着隐患跑起来
	if !c.devMode {
		if c.wechatAppID == "" || c.wechatSecret == "" {
			return c, fmt.Errorf("非 DEV_MODE 时必须设置 WECHAT_APPID / WECHAT_SECRET")
		}
		if string(c.jwtSecret) == devJWTSecret || len(c.jwtSecret) < 32 {
			return c, fmt.Errorf("非 DEV_MODE 时 JWT_SECRET 必须换成至少 32 字节的随机值（openssl rand -base64 48）")
		}
	}
	return c, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
