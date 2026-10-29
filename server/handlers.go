package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

const (
	maxPushRows  = 500     // 单次上传上限，客户端超出要分批
	pullPageSize = 1000    // 单次下拉上限，超出 hasMore=true
	maxBodyBytes = 2 << 20 // 2MB
)

/* ---------------- 小工具 ---------------- */

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("写响应失败: %v", err)
	}
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, errBody{Error: apiErr{Code: code, Message: msg}})
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			writeErr(w, http.StatusBadRequest, "BODY_EMPTY", "请求体为空")
		} else {
			writeErr(w, http.StatusBadRequest, "BODY_INVALID", "请求体不是合法 JSON: "+err.Error())
		}
		return false
	}
	return true
}

// dbFail：数据库错误统一处理。用户被删（token 还有效）→ 401，让客户端重新登录。
func dbFail(w http.ResponseWriter, what string, err error) {
	if errors.Is(err, errUserGone) {
		writeErr(w, http.StatusUnauthorized, "AUTH_EXPIRED", "用户不存在，请重新登录")
		return
	}
	log.Printf("%s: %v", what, err)
	writeErr(w, http.StatusInternalServerError, "DB_ERROR", what+"失败")
}

/* ---------------- 登录 ---------------- */

func (a *app) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !readJSON(w, r, &req) {
		return
	}
	code := strings.TrimSpace(req.Code)
	if code == "" || len(code) > 128 {
		writeErr(w, http.StatusBadRequest, "CODE_INVALID", "code 为空或过长")
		return
	}

	var openid string
	if a.cfg.devMode {
		// 联调模式：不走微信，同一个 code 永远是同一个用户
		openid = "dev-" + code
	} else {
		got, err := a.code2session(r.Context(), code)
		if err != nil {
			log.Printf("code2session: %v", err)
			writeErr(w, http.StatusBadGateway, "WECHAT_FAILED", "微信登录失败，请重试")
			return
		}
		openid = got
	}

	uid, err := a.st.upsertUserByOpenID(r.Context(), openid)
	if err != nil {
		dbFail(w, "创建用户", err)
		return
	}

	token, exp, err := a.signToken(uid, openid)
	if err != nil {
		log.Printf("签 token: %v", err)
		writeErr(w, http.StatusInternalServerError, "TOKEN_ERROR", "签发 token 失败")
		return
	}

	writeJSON(w, http.StatusOK, loginResponse{Token: token, ExpiresAt: rfc3339(exp)})
}

/* ---------------- 同步（唯一的写入口） ---------------- */

// handleSync：先推后拉，一次往返。
//
//	推：校验 → 夹紧时钟 → 一个事务里按 LWW 写入（store.push）
//	拉：按 rev 取 cursor 之后的增量（store.pull），去掉「客户端刚推上来且赢了」的行
//
// 推和拉是两个事务：推成功、拉失败时客户端拿到 500 会整体重试，
// 因为写入是幂等的（自然主键 + LWW），重推不会产生任何副作用。
func (a *app) handleSync(w http.ResponseWriter, r *http.Request) {
	var req syncRequest
	if !readJSON(w, r, &req) {
		return
	}
	if len(req.Sets)+len(req.Metrics) > maxPushRows {
		writeErr(w, http.StatusBadRequest, "TOO_MANY_ROWS", "单次同步最多 500 条，请分批提交")
		return
	}

	uid := uidFrom(r)
	now := time.Now().UTC()
	rejected := []rejectedRow{}

	sets := make([]setIn, 0, len(req.Sets))
	for i := range req.Sets {
		row := req.Sets[i]
		reason := validateSet(&row)
		at, ok := clientTime(row.UpdatedAt, now)
		if reason == "" && !ok {
			reason = "updatedAt 必须是 RFC3339"
		}
		if reason != "" {
			rejected = append(rejected, rejectedRow{Kind: "set", Index: i, Reason: reason})
			continue
		}
		sets = append(sets, setIn{SetRow: row, at: at})
	}

	metrics := make([]metricIn, 0, len(req.Metrics))
	for i := range req.Metrics {
		row := req.Metrics[i]
		reason := validateMetric(&row)
		at, ok := clientTime(row.UpdatedAt, now)
		if reason == "" && !ok {
			reason = "updatedAt 必须是 RFC3339"
		}
		if reason != "" {
			rejected = append(rejected, rejectedRow{Kind: "metric", Index: i, Reason: reason})
			continue
		}
		metrics = append(metrics, metricIn{MetricRow: row, at: at})
	}

	var cfg *configIn
	if req.Config != nil {
		reason := validateConfig(req.Config)
		at, ok := clientTime(req.Config.UpdatedAt, now)
		if reason == "" && !ok {
			reason = "updatedAt 必须是 RFC3339"
		}
		if reason != "" {
			rejected = append(rejected, rejectedRow{Kind: "config", Index: 0, Reason: reason})
		} else {
			cfg = &configIn{ConfigDoc: *req.Config, at: at}
		}
	}

	pushed, err := a.st.push(r.Context(), uid, sets, metrics, cfg)
	if err != nil {
		dbFail(w, "写入", err)
		return
	}

	pulled, err := a.st.pull(r.Context(), uid, req.Cursor, pullPageSize)
	if err != nil {
		dbFail(w, "读取增量", err)
		return
	}

	// 客户端刚推上来且赢了的行，它手里就是这份，不必回传。
	// 必须比对 rev：推完到拉之间如果别的设备又改了同一行，rev 会变，那就得回传。
	outSets := make([]SetRow, 0, len(pulled.sets))
	for _, s := range pulled.sets {
		if rev, ok := pushed.won[s.key()]; ok && rev == s.rev {
			continue
		}
		outSets = append(outSets, s)
	}
	outMetrics := make([]MetricRow, 0, len(pulled.metrics))
	for _, m := range pulled.metrics {
		if rev, ok := pushed.won[m.key()]; ok && rev == m.rev {
			continue
		}
		outMetrics = append(outMetrics, m)
	}
	outCfg := pulled.config
	if outCfg != nil {
		if rev, ok := pushed.won["config"]; ok && rev == outCfg.rev {
			outCfg = nil
		}
	}

	writeJSON(w, http.StatusOK, syncResponse{
		Cursor:     pulled.cursor,
		HasMore:    pulled.hasMore,
		Applied:    pushed.applied,
		Rejected:   rejected,
		Sets:       outSets,
		Metrics:    outMetrics,
		Config:     outCfg,
		ServerTime: rfc3339(now),
	})
}

/* ---------------- 只读查询 ---------------- */

func (a *app) handleHistorySummary(w http.ResponseWriter, r *http.Request) {
	sum, err := a.st.historySummary(r.Context(), uidFrom(r), a.cfg.loc)
	if err != nil {
		dbFail(w, "统计", err)
		return
	}
	writeJSON(w, http.StatusOK, sum)
}

func (a *app) handleGetMetrics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	for _, k := range []string{"from", "to"} {
		if v := q.Get(k); v != "" && !validDate(v) {
			writeErr(w, http.StatusBadRequest, "DATE_INVALID", k+" 必须是 YYYY-MM-DD")
			return
		}
	}
	rows, err := a.st.metricsRange(r.Context(), uidFrom(r), q.Get("kind"), q.Get("from"), q.Get("to"))
	if err != nil {
		dbFail(w, "读取指标", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"metrics": rows})
}

/* ---------------- 健康检查 ---------------- */

// healthz：进程活着就 200（给容器编排做存活探测，不碰数据库，
// 否则数据库抖一下所有实例会被同时重启）。
func (a *app) handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "time": rfc3339(time.Now())})
}

// readyz：数据库可达才 200（给负载均衡摘流量用）。
func (a *app) handleReadyz(w http.ResponseWriter, r *http.Request) {
	if err := a.st.ping(r.Context()); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "DB_DOWN", "数据库不可达")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
