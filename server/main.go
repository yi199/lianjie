package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type app struct {
	cfg config
	st  *store
}

func timeNow() time.Time { return time.Now() }

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[练界] ")

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("配置错误: %v", err)
	}
	if cfg.devMode {
		log.Printf("⚠️  DEV_MODE 已开启：登录不校验微信，dev-<code> 即用户")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	s, err := connectWithRetry(ctx, cfg.databaseURL, cfg.dbMaxConns)
	if err != nil {
		log.Fatalf("数据库: %v", err)
	}
	defer s.close()

	if err := s.migrate(ctx); err != nil {
		log.Fatalf("建表: %v", err)
	}
	log.Printf("数据库就绪，时区 %s，连接池上限 %d", cfg.loc, cfg.dbMaxConns)

	a := &app{cfg: cfg, st: s}

	// 同步：每用户每秒 2 次、突发 20 次。正常客户端 30 秒一次，碰不到上限
	userLimit := newLimiter(2, 20)
	ipLimit := newLimiter(1, 10)
	// 动作库清单：会被 onShow 频繁触发，单独限流。
	// 复用人 /login 的 ipLimit(1,10) 会让正常用户撞限流，运营商 NAT 下整片 IP 更糟。
	catalogLimit := newLimiter(2, 60)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/healthz", a.handleHealthz)
	mux.HandleFunc("GET /api/readyz", a.handleReadyz)

	mux.HandleFunc("POST /api/login", ipLimit.byIP(a.handleLogin))
	mux.HandleFunc("POST /api/sync", a.requireAuth(userLimit.byUser(a.handleSync)))
	mux.HandleFunc("GET /api/history/summary", a.requireAuth(userLimit.byUser(a.handleHistorySummary)))
	mux.HandleFunc("GET /api/metrics", a.requireAuth(userLimit.byUser(a.handleGetMetrics)))

	// 动作库：清单免登录（只给缩略图），详情要登录（大图在登录后面）
	mux.HandleFunc("GET /api/catalog", catalogLimit.byIP(a.handleCatalog))
	mux.HandleFunc("GET /api/exercises/{id}", a.requireAuth(a.handleExerciseDetail))

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           withLogging(withTimeout(mux, 10*time.Second)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("监听 %s", cfg.addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务启动失败: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("收到退出信号，正在关闭…")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("关闭超时: %v", err)
	}
	log.Printf("已退出")
}

// connectWithRetry：docker compose 刚起来时 Postgres 可能还没就绪，重试而不是直接崩。
func connectWithRetry(ctx context.Context, dsn string, maxConns int32) (*store, error) {
	const tries = 15
	var lastErr error
	for i := 1; i <= tries; i++ {
		s, err := newStore(ctx, dsn, maxConns)
		if err == nil {
			return s, nil
		}
		lastErr = err
		log.Printf("连接数据库失败（%d/%d）: %v", i, tries, err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return nil, lastErr
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s → %d (%s)", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

// withTimeout：每个请求最多 10 秒。超时后 context 取消，正在跑的 SQL 会被 pgx 中断，
// 连接回到池里——一条慢查询不会拖住整个连接池。
func withTimeout(next http.Handler, d time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), d)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}
