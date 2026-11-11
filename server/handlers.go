package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
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
	return readJSONMax(w, r, dst, maxBodyBytes)
}

// readJSONMax：同 readJSON，但可以给单条请求更小的体积上限
// （错误上报这类接口不需要 2MB，给 8KB 就够，别让它成为上传通道）。
func readJSONMax(w http.ResponseWriter, r *http.Request, dst any, max int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
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
	if len(req.Sets)+len(req.Workouts)+len(req.Metrics)+len(req.CustomExercises) > maxPushRows {
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

	workouts := make([]workoutIn, 0, len(req.Workouts))
	for i := range req.Workouts {
		row := req.Workouts[i]
		reason := validateWorkout(&row)
		at, ok := clientTime(row.UpdatedAt, now)
		if reason == "" && !ok {
			reason = "updatedAt 必须是 RFC3339"
		}
		if reason != "" {
			rejected = append(rejected, rejectedRow{Kind: "workout", Index: i, Reason: reason})
			continue
		}
		// startedAt / finishedAt 原样带字符串，由 SQL 转 timestamptz（见 store.go 注释）
		workouts = append(workouts, workoutIn{WorkoutRow: row, at: at})
	}

	// 自建动作（动作库）：和 sets 一样的校验 + 时钟夹紧。
	// 它们是用户输入，最容易被拒——被拒的原因必须回到客户端显示（动作库.md §7.4）。
	exercises := make([]customExerciseIn, 0, len(req.CustomExercises))
	for i := range req.CustomExercises {
		row := req.CustomExercises[i]
		reason := validateCustomExercise(&row)
		at, ok := clientTime(row.UpdatedAt, now)
		if reason == "" && !ok {
			reason = "updatedAt 必须是 RFC3339"
		}
		if reason != "" {
			rejected = append(rejected, rejectedRow{Kind: "customExercise", Index: i, Reason: reason})
			continue
		}
		exercises = append(exercises, customExerciseIn{CustomExerciseRow: row, at: at})
	}

	pushed, err := a.st.push(r.Context(), uid, sets, workouts, metrics, exercises, cfg)
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
	// workouts 一律回传，不做去回声：它是按字段合并的（开始取早、结束取晚），
	// 合并结果可能和客户端刚推上来的不一样。不回传的话，后上传但开始得晚的那台设备
	// 会一直留着自己的 startedAt，和服务端永远对不上。一天一行，流量可以忽略。
	outWorkouts := pulled.workouts
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
	// 自建动作和 sets 一样去回声：赢了的行客户端手里就是这份
	outExercises := make([]CustomExerciseRow, 0, len(pulled.customExercises))
	for _, x := range pulled.customExercises {
		if rev, ok := pushed.won[x.key()]; ok && rev == x.rev {
			continue
		}
		outExercises = append(outExercises, x)
	}

	writeJSON(w, http.StatusOK, syncResponse{
		Cursor:          pulled.cursor,
		HasMore:         pulled.hasMore,
		Applied:         pushed.applied,
		Rejected:        rejected,
		Sets:            outSets,
		Workouts:        outWorkouts,
		Metrics:         outMetrics,
		CustomExercises: outExercises,
		Config:          outCfg,
		CatalogRev:      pulled.catalogRev,
		ServerTime:      rfc3339(now),
	})
}

/* ---------------- 官方动作库 ---------------- */

// handleCatalog：整份清单，免登录、只给缩略图。
//
// since 只决定「要不要给」：since >= 当前 rev 返回 304（空 body），否则整份返回。
// 客户端因此只有一条写入路径——整份替换，不需要处理增量合并。
// rev 自愈：客户端存了个比服务端大的 rev（服务端被重置过），since >= rev 恒成立，
// 清单就再也不刷新；所以本地 rev 大于服务端时，客户端要按 0 处理（契约 §4.6）。
func (a *app) handleCatalog(w http.ResponseWriter, r *http.Request) {
	since := int64(-1) // 没传 = 一定给
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			writeErr(w, http.StatusBadRequest, "SINCE_INVALID", "since 必须是非负整数")
			return
		}
		since = n
	}

	rev, err := a.st.catalogRevOf(r.Context())
	if err != nil {
		dbFail(w, "读取动作库版本", err)
		return
	}
	if since >= rev {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	list, err := a.st.catalogList(r.Context())
	if err != nil {
		dbFail(w, "读取动作库", err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleExerciseDetail：动作详情（讲解 + 大图），要登录。
// 图片和 steps 都允许为空；失败不该阻塞页面主体。
func (a *app) handleExerciseDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || len(id) > 16 {
		writeErr(w, http.StatusBadRequest, "ID_INVALID", "动作 id 不合法")
		return
	}
	d, err := a.st.catalogDetail(r.Context(), id)
	if errors.Is(err, errExerciseNotFound) {
		writeErr(w, http.StatusNotFound, "EXERCISE_NOT_FOUND", "动作不存在")
		return
	}
	if err != nil {
		dbFail(w, "读取动作详情", err)
		return
	}
	writeJSON(w, http.StatusOK, d)
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

/* ---------------- 删除账号（合规：删除个人信息） ---------------- */

// handleDeleteAccount：删掉当前用户的全部数据。
//
// 五张业务表（sets / workouts / metrics / user_config / user_exercises）都是
// `references users(id) on delete cascade`，所以一条 delete 就够，不会留孤儿行。
// 幂等：用户已经不在了也返回 200（deleted=false），客户端不必区分。
//
// 注意：客户端本地数据要自己清（页面在成功后调 db.resetAll()）——
// 服务端删不到别人手机上的本地存储。
func (a *app) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	uid := uidFrom(r)
	deleted, err := a.st.deleteAccount(r.Context(), uid)
	if err != nil {
		dbFail(w, "删除账号", err)
		return
	}
	log.Printf("账号已删除 uid=%d（级联清空全部业务表）deleted=%v", uid, deleted)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

/* ---------------- 客户端错误上报 ---------------- */

const (
	maxClientErrBody  = 8 << 10 // 8KB：栈再长也够，别让这个接口变成上传通道
	maxClientErrMsg   = 500     // 字符数（不是字节，中文按字算）
	maxClientErrStack = 2000
	maxClientErrField = 128
)

// 只认客户端 app.js 真正会报的三种，别的当垃圾挡在门外
var clientErrKinds = map[string]bool{
	"onError":              true,
	"onUnhandledRejection": true,
	"onPageNotFound":       true,
}

// oneLine：日志里一条错误必须占一行。栈里全是换行，不压掉的话一条错误会把
// 日志刷成几十行，出问题时反而看不清是哪几条。
func oneLine(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", " ⏎ ")
	return strings.TrimSpace(s)
}

// handleClientError：小程序的兜底钩子上报的错误，只记日志、不落库。
//
// 免登录：登录流程本身就可能出错，要求 token 会让最该上报的那类错误报不上来。
// 靠 IP 限流 + 8KB 体积上限 + 字段长度上限挡住滥用。
func (a *app) handleClientError(w http.ResponseWriter, r *http.Request) {
	var req clientError
	if !readJSONMax(w, r, &req, maxClientErrBody) {
		return
	}
	if !clientErrKinds[req.Kind] {
		writeErr(w, http.StatusBadRequest, "KIND_INVALID", "kind 不认识")
		return
	}
	if !shortText(req.Msg, maxClientErrMsg) || !shortText(req.Stack, maxClientErrStack) ||
		!shortText(req.Page, maxClientErrField) || !shortText(req.Path, maxClientErrField) ||
		!shortText(req.Sid, maxClientErrField) || !shortText(req.Env, 16) {
		writeErr(w, http.StatusBadRequest, "FIELD_TOO_LONG", "字段超长")
		return
	}

	log.Printf("[客户端错误] env=%s page=%s kind=%s path=%s sid=%s at=%s msg=%s stack=%s",
		oneLine(req.Env), oneLine(req.Page), req.Kind, oneLine(req.Path),
		oneLine(req.Sid), oneLine(req.At), oneLine(req.Msg), oneLine(req.Stack))

	w.WriteHeader(http.StatusNoContent)
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
