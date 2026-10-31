package main

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// limiter：按 key 的令牌桶，进程内存实现。
//
// 目的不是防攻击（那是 Nginx limit_req 的事），而是兜住客户端 bug：
// 一个同步死循环的小程序不该把数据库连接池吃光、拖垮所有其他用户。
// 多实例部署时每个实例各算各的，上限会放大 N 倍——对这个目的足够。
type limiter struct {
	mu      sync.Mutex
	rate    float64 // 每秒补充的令牌
	burst   float64
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(rate, burst float64) *limiter {
	l := &limiter{rate: rate, burst: burst, buckets: map[string]*bucket{}}
	go l.gc()
	return l
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// gc：桶满了就等于没记录，删掉，防止 map 无限增长
func (l *limiter) gc() {
	for range time.Tick(time.Minute) {
		now := time.Now()
		l.mu.Lock()
		for k, b := range l.buckets {
			if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
				delete(l.buckets, k)
			}
		}
		l.mu.Unlock()
	}
}

// byUser：已登录接口按 uid 限流
func (l *limiter) byUser(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !l.allow("u"+itoa64(uidFrom(r)), time.Now()) {
			w.Header().Set("Retry-After", "5")
			writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "请求太频繁，稍后再试")
			return
		}
		next(w, r)
	}
}

// byIP：登录接口没有 uid，按来源 IP 限流
func (l *limiter) byIP(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !l.allow("ip"+clientIP(r), time.Now()) {
			w.Header().Set("Retry-After", "5")
			writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "请求太频繁，稍后再试")
			return
		}
		next(w, r)
	}
}

// clientIP：在 Nginx 后面时取 X-Real-IP（由 Nginx 覆盖写入，客户端伪造不了）
func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }
