package main

// 集成测试：真 Postgres + 真 HTTP 处理链（鉴权 → 限流 → 同步）。
//
// 跑法（需要一个能随便清空的库）：
//
//	docker compose up -d db
//	TEST_DATABASE_URL=postgres://lianjie:lianjie_dev_pw@localhost:5432/lianjie?sslmode=disable go test ./...
//
// 没设 TEST_DATABASE_URL 时整个文件跳过，单元测试照常跑。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"
)

type testEnv struct {
	t   *testing.T
	srv *httptest.Server
	st  *store
}

func newTestEnv(t *testing.T) *testEnv {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("未设置 TEST_DATABASE_URL，跳过集成测试")
	}
	ctx := context.Background()
	st, err := newStore(ctx, dsn, 10)
	if err != nil {
		t.Fatalf("连库: %v", err)
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatalf("建表: %v", err)
	}
	loc, _ := time.LoadLocation("Asia/Shanghai")
	a := &app{cfg: config{devMode: true, jwtSecret: []byte("test"), tokenTTL: time.Hour, loc: loc}, st: st}

	// 限流放宽：测试本身会高频请求
	lim := newLimiter(10000, 10000)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", a.handleLogin)
	mux.HandleFunc("POST /api/sync", a.requireAuth(lim.byUser(a.handleSync)))
	mux.HandleFunc("GET /api/history/summary", a.requireAuth(a.handleHistorySummary))
	// 动作库：清单免登录，详情要登录（和 main.go 的路由一致）
	mux.HandleFunc("GET /api/catalog", a.handleCatalog)
	mux.HandleFunc("GET /api/exercises/{id}", a.requireAuth(a.handleExerciseDetail))

	env := &testEnv{t: t, srv: httptest.NewServer(withTimeout(mux, 10*time.Second)), st: st}
	t.Cleanup(func() { env.srv.Close(); st.close() })
	return env
}

// 每个测试一个全新用户，互不干扰，也不用清库
func (e *testEnv) login(code string) string {
	var out loginResponse
	e.do("", "POST", "/api/login", loginRequest{Code: code + "-" + fmt.Sprint(time.Now().UnixNano())}, &out, 200)
	return out.Token
}

func (e *testEnv) do(token, method, path string, body, out any, wantStatus int) {
	e.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != wantStatus {
		var eb errBody
		json.NewDecoder(resp.Body).Decode(&eb)
		e.t.Fatalf("%s %s: 期望 %d，得到 %d %+v", method, path, wantStatus, resp.StatusCode, eb)
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			e.t.Fatalf("解析响应: %v", err)
		}
	}
}

func (e *testEnv) sync(token string, req syncRequest) syncResponse {
	e.t.Helper()
	var out syncResponse
	e.do(token, "POST", "/api/sync", req, &out, 200)
	return out
}

// pullAll：模拟一台新设备，从 cursor=0 翻页拉到底
func (e *testEnv) pullAll(token string) (map[string]SetRow, *ConfigDoc, int64) {
	e.t.Helper()
	got := map[string]SetRow{}
	var cfg *ConfigDoc
	cursor := int64(0)
	for i := 0; i < 100; i++ {
		r := e.sync(token, syncRequest{Cursor: cursor})
		for _, s := range r.Sets {
			got[s.key()] = s
		}
		if r.Config != nil {
			cfg = r.Config
		}
		cursor = r.Cursor
		if !r.HasMore {
			return got, cfg, cursor
		}
	}
	e.t.Fatal("翻页 100 次还没拉完")
	return nil, nil, 0
}

func ts(sec int) string {
	return time.Date(2026, 10, 29, 10, 0, sec, 0, time.UTC).Format(time.RFC3339Nano)
}

func mkSet(date, ex string, no int, weight float64, at string) SetRow {
	return SetRow{Date: date, ExID: ex, SetNo: no, ExCn: "卧推", Part: "chest", PlanKey: "A",
		Sig: "some|3|gym|auto", Weight: weight, Reps: 10, Unit: "kg", Done: true, UpdatedAt: at}
}

func TestIntegrationIdempotentRetry(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("idem")
	row := mkSet("2026-10-29", "g1", 1, 50, ts(1))

	for i := 0; i < 3; i++ {
		e.sync(tok, syncRequest{Sets: []SetRow{row}})
	}
	all, _, _ := e.pullAll(tok)
	if len(all) != 1 {
		t.Fatalf("重复上传 3 次应只有 1 行，得到 %d", len(all))
	}
}

func TestIntegrationEchoSkipped(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("echo")
	r := e.sync(tok, syncRequest{Sets: []SetRow{mkSet("2026-10-29", "g1", 1, 50, ts(1))}})
	if r.Applied != 1 {
		t.Fatalf("applied 应为 1，得到 %d", r.Applied)
	}
	if len(r.Sets) != 0 {
		t.Fatalf("自己刚推上去且赢了的行不该回传，得到 %d 行", len(r.Sets))
	}
}

func TestIntegrationLWW(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("lww")

	e.sync(tok, syncRequest{Sets: []SetRow{mkSet("2026-10-29", "g1", 1, 60, ts(20))}})

	// 更旧的写入：不覆盖，而且服务端要把赢家版本推回来
	r := e.sync(tok, syncRequest{Sets: []SetRow{mkSet("2026-10-29", "g1", 1, 40, ts(10))}})
	if r.Applied != 0 {
		t.Fatalf("旧数据不该写入，applied=%d", r.Applied)
	}
	if len(r.Sets) != 1 || r.Sets[0].Weight != 60 {
		t.Fatalf("应回传赢家版本 60kg，得到 %+v", r.Sets)
	}

	// 更新的写入：覆盖
	e.sync(tok, syncRequest{Sets: []SetRow{mkSet("2026-10-29", "g1", 1, 65, ts(30))}})
	all, _, _ := e.pullAll(tok)
	if got := all[mkSet("2026-10-29", "g1", 1, 0, "").key()].Weight; got != 65 {
		t.Fatalf("应为 65，得到 %v", got)
	}
}

// 旧协议按 updated_at > since 拉增量，时钟偏慢的设备写的行会被别的设备永久漏掉。
// 现在按 rev 拉，和时钟无关。
func TestIntegrationClockSkewNotMissed(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("skew")

	// 设备 A 先同步，拿到游标
	e.sync(tok, syncRequest{Sets: []SetRow{mkSet("2026-10-29", "g1", 1, 50, ts(50))}})
	_, _, curA := e.pullAll(tok)

	// 设备 B 时钟慢了很多，写一条「过去时刻」的新行
	old := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	e.sync(tok, syncRequest{Sets: []SetRow{mkSet("2026-10-29", "g6", 1, 40, old)}})

	// 设备 A 接着自己的游标拉，必须看得到
	r := e.sync(tok, syncRequest{Cursor: curA})
	if len(r.Sets) != 1 || r.Sets[0].ExID != "g6" {
		t.Fatalf("设备 A 漏掉了时钟偏慢设备写的行: %+v", r.Sets)
	}
}

func TestIntegrationTombstone(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("tomb")
	e.sync(tok, syncRequest{Sets: []SetRow{mkSet("2026-10-29", "g1", 1, 50, ts(1))}})
	_, _, cur := e.pullAll(tok)

	del := mkSet("2026-10-29", "g1", 1, 50, ts(2))
	del.Done = false
	e.sync(tok, syncRequest{Sets: []SetRow{del}})

	// 另一台设备要收到墓碑，否则它那份会被「传回来」
	all, _, _ := e.pullAll(tok)
	if row := all[del.key()]; row.Done {
		t.Fatal("墓碑没生效")
	}
	r := e.sync(tok, syncRequest{Cursor: cur})
	if len(r.Sets) != 1 || r.Sets[0].Done {
		t.Fatalf("增量里应有一条墓碑: %+v", r.Sets)
	}

	var sum historySummary
	e.do(tok, "GET", "/api/history/summary", nil, &sum, 200)
	if sum.TotalDays != 0 {
		t.Fatalf("墓碑不该计入统计，totalDays=%d", sum.TotalDays)
	}
}

func TestIntegrationPagination(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("page")

	const n = 1234
	batch := []SetRow{}
	for i := 0; i < n; i++ {
		d := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, i/10).Format("2006-01-02")
		batch = append(batch, mkSet(d, "g1", i%10+1, 50, ts(1)))
		if len(batch) == maxPushRows || i == n-1 {
			e.sync(tok, syncRequest{Sets: batch})
			batch = nil
		}
	}

	all, _, _ := e.pullAll(tok)
	if len(all) != n {
		t.Fatalf("新设备应拉到 %d 行，得到 %d", n, len(all))
	}
}

func TestIntegrationRejectsBadRows(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("bad")
	bad := mkSet("2026-13-01", "g1", 1, 50, ts(1))
	noTime := mkSet("2026-10-29", "g1", 2, 50, "")
	good := mkSet("2026-10-29", "g1", 1, 50, ts(1))

	r := e.sync(tok, syncRequest{Sets: []SetRow{bad, good, noTime}})
	if r.Applied != 1 || len(r.Rejected) != 2 || r.Rejected[0].Index != 0 || r.Rejected[1].Index != 2 {
		t.Fatalf("坏行应被逐条拒收、好行照常写入: applied=%d rejected=%+v", r.Applied, r.Rejected)
	}

	tooMany := make([]SetRow, maxPushRows+1)
	e.do(tok, "POST", "/api/sync", syncRequest{Sets: tooMany}, nil, 400)
}

func TestIntegrationConfigLWW(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("cfg")

	e.sync(tok, syncRequest{Config: &ConfigDoc{Body: json.RawMessage(`{"v":2}`), UpdatedAt: ts(20)}})
	r := e.sync(tok, syncRequest{Config: &ConfigDoc{Body: json.RawMessage(`{"v":1}`), UpdatedAt: ts(10)}})
	if r.Config == nil || string(r.Config.Body) != `{"v": 2}` && string(r.Config.Body) != `{"v":2}` {
		t.Fatalf("旧配置不该覆盖，且应回传赢家: %+v", r.Config)
	}

	_, cfg, _ := e.pullAll(tok)
	var body map[string]int
	json.Unmarshal(cfg.Body, &body)
	if body["v"] != 2 {
		t.Fatalf("新设备应拉到 v=2，得到 %s", cfg.Body)
	}
}

func TestIntegrationUserIsolation(t *testing.T) {
	e := newTestEnv(t)
	a := e.login("iso-a")
	b := e.login("iso-b")
	e.sync(a, syncRequest{Sets: []SetRow{mkSet("2026-10-29", "g1", 1, 50, ts(1))}})

	all, _, _ := e.pullAll(b)
	if len(all) != 0 {
		t.Fatalf("用户 B 看到了用户 A 的 %d 行", len(all))
	}
	e.do("", "POST", "/api/sync", syncRequest{}, nil, 401)
	e.do("not-a-token", "POST", "/api/sync", syncRequest{}, nil, 401)
}

// 并发：同一用户多台设备同时上传，另一台设备一边拉一边推进游标。
// 只要 rev 的分配顺序和提交顺序不一致，拉的那台就会漏行——这个测试专门抓它。
func TestIntegrationConcurrentWriters(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("conc")

	const writers, perWriter = 8, 60
	var wg sync.WaitGroup
	done := make(chan struct{})

	seen := map[string]bool{}
	var mu sync.Mutex
	cursor := int64(0)
	pull := func() {
		r := e.sync(tok, syncRequest{Cursor: cursor})
		mu.Lock()
		for _, s := range r.Sets {
			seen[s.key()] = true
		}
		mu.Unlock()
		cursor = r.Cursor
	}

	pullerDone := make(chan struct{})
	go func() {
		defer close(pullerDone)
		for {
			select {
			case <-done:
				return
			default:
				pull()
			}
		}
	}()

	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i += 5 {
				rows := []SetRow{}
				for k := 0; k < 5; k++ {
					d := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, w).Format("2006-01-02")
					rows = append(rows, mkSet(d, fmt.Sprintf("g%d", i+k+1), 1, 50, ts(1)))
				}
				e.sync(tok, syncRequest{Sets: rows})
			}
		}(w)
	}
	wg.Wait()
	close(done)
	<-pullerDone

	// 写完之后再从游标拉一次收尾：并发期间没漏的话，这里补的只是最后一小段
	for {
		before := cursor
		pull()
		if cursor == before {
			break
		}
	}
	if len(seen) != writers*perWriter {
		t.Fatalf("边写边拉应看到 %d 行，实际 %d —— rev 顺序与提交顺序不一致会导致漏行",
			writers*perWriter, len(seen))
	}
}

/* ---------------- 训练记录模块（workouts） ---------------- */

func mkWorkout(date, start, at string) WorkoutRow {
	return WorkoutRow{
		Date: date, PlanKey: "A", PlanName: "推日", Sig: "some|3|gym|auto",
		ProgramID: "auto", StartedAt: start, Note: "", Done: true, UpdatedAt: at,
	}
}

// pullWorkouts 拉到 hasMore=false 为止，返回按日期索引的 workout 行（含墓碑）。
func (e *testEnv) pullWorkouts(token string) map[string]WorkoutRow {
	out := map[string]WorkoutRow{}
	cur := int64(0)
	for i := 0; ; i++ {
		if i > 50 {
			e.t.Fatal("分页没有终止")
		}
		r := e.sync(token, syncRequest{Cursor: cur})
		for _, wk := range r.Workouts {
			out[wk.key()] = wk
		}
		cur = r.Cursor
		if !r.HasMore {
			break
		}
	}
	return out
}

// 模块设计 §6.2：workouts 按字段合并，不是整行 LWW。
// 两台设备同一天都练过时，整行 LWW 会丢掉较早的开始时刻。
func TestIntegrationWorkoutFieldMerge(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("wmerge")
	const d = "2026-10-29"

	// 设备 A：10:00 开始，11:00 结束
	a := mkWorkout(d, "2026-10-29T10:00:00.000Z", ts(1))
	finA := "2026-10-29T11:00:00.000Z"
	a.FinishedAt = &finA
	a.PlanKey = "A"
	e.sync(tok, syncRequest{Workouts: []WorkoutRow{a}})

	// 设备 B：开始更早、结束更晚，且 updatedAt 更新（计划字段应该被 B 覆盖）
	b := mkWorkout(d, "2026-10-29T09:30:00.000Z", ts(9))
	finB := "2026-10-29T11:30:00.000Z"
	b.FinishedAt = &finB
	b.PlanKey = "C"
	e.sync(tok, syncRequest{Workouts: []WorkoutRow{b}})

	got := e.pullWorkouts(tok)[b.key()]

	wantStart, _ := time.Parse(time.RFC3339Nano, "2026-10-29T09:30:00.000Z")
	gotStart, err := time.Parse(time.RFC3339Nano, got.StartedAt)
	if err != nil {
		t.Fatalf("startedAt 无法解析: %q", got.StartedAt)
	}
	if !gotStart.Equal(wantStart) {
		t.Fatalf("started_at 应取较早的 09:30，得到 %s（整行 LWW 会丢信息）", got.StartedAt)
	}

	if got.FinishedAt == nil {
		t.Fatal("finishedAt 丢了")
	}
	wantFin, _ := time.Parse(time.RFC3339Nano, "2026-10-29T11:30:00.000Z")
	gotFin, _ := time.Parse(time.RFC3339Nano, *got.FinishedAt)
	if !gotFin.Equal(wantFin) {
		t.Fatalf("finished_at 应取较晚的 11:30，得到 %s", *got.FinishedAt)
	}

	if got.PlanKey != "C" {
		t.Fatalf("计划字段应按 updated_at LWW，期望 C，得到 %q", got.PlanKey)
	}
}

// 模块设计 §11 第 5 条：旧版客户端不带新字段上传，不能把已有值清空。
func TestIntegrationSetNewFieldsSurviveOldClient(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("newf")
	const d = "2026-10-29"

	slot, rir, treps, tsets := 2, 1, 10, 4
	tw, assist := 52.5, 5.0
	ca := "2026-10-29T10:05:00.000Z"
	row := mkSet(d, "g1", 1, 50, ts(1))
	row.Slot = &slot
	row.Rir = &rir
	row.TargetReps = &treps
	row.TargetSets = &tsets
	row.TargetWeight = &tw
	row.Assist = &assist
	row.CompletedAt = &ca
	e.sync(tok, syncRequest{Sets: []SetRow{row}})

	// 旧版客户端：完全不带新字段（全 nil），但 updatedAt 更晚、改了重量
	old := mkSet(d, "g1", 1, 55, ts(9))
	e.sync(tok, syncRequest{Sets: []SetRow{old}})

	all, _, _ := e.pullAll(tok)
	got := all[row.key()]

	if got.Weight != 55 {
		t.Fatalf("LWW 应让新重量生效，期望 55，得到 %v", got.Weight)
	}
	if got.Slot == nil || *got.Slot != slot {
		t.Fatalf("slot 被旧客户端清空了：%v", got.Slot)
	}
	if got.Rir == nil || *got.Rir != rir {
		t.Fatalf("rir 被清空了：%v", got.Rir)
	}
	if got.TargetReps == nil || *got.TargetReps != treps {
		t.Fatalf("targetReps 被清空了：%v", got.TargetReps)
	}
	if got.TargetSets == nil || *got.TargetSets != tsets {
		t.Fatalf("targetSets 被清空了：%v", got.TargetSets)
	}
	if got.TargetWeight == nil || *got.TargetWeight != tw {
		t.Fatalf("targetWeight 被清空了：%v", got.TargetWeight)
	}
	if got.Assist == nil || *got.Assist != assist {
		t.Fatalf("assist 被清空了：%v", got.Assist)
	}
	if got.CompletedAt == nil {
		t.Fatal("completedAt 被清空了")
	}
}

// 模块设计 §6.2 / §7.3：workouts.done 由服务端按 sets 重新计算，与上传顺序无关。
func TestIntegrationWorkoutDoneFollowsSets(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("wdone")
	const d = "2026-10-29"

	s := mkSet(d, "g1", 1, 50, ts(1))
	w := mkWorkout(d, "2026-10-29T10:00:00.000Z", ts(1))

	// 同一批上传：组和训练一起到
	e.sync(tok, syncRequest{Sets: []SetRow{s}, Workouts: []WorkoutRow{w}})
	if !e.pullWorkouts(tok)[w.key()].Done {
		t.Fatal("有 done=true 的组时，workout 应为 true")
	}

	// 当天的组全部取消（墓碑）→ 这次训练消失
	del := s
	del.UpdatedAt = ts(2)
	del.Done = false
	e.sync(tok, syncRequest{Sets: []SetRow{del}})
	if e.pullWorkouts(tok)[w.key()].Done {
		t.Fatal("组全部取消后，workout.done 应为 false")
	}

	// 再完成一组 → 训练恢复
	back := s
	back.UpdatedAt = ts(3)
	back.Done = true
	e.sync(tok, syncRequest{Sets: []SetRow{back}})
	if !e.pullWorkouts(tok)[w.key()].Done {
		t.Fatal("再完成一组后，workout.done 应恢复 true")
	}

	// 只有 workouts、没有 sets 的那一天，done 应为 false（以 sets 为准）
	const empty = "2026-10-30"
	we := mkWorkout(empty, "2026-10-30T10:00:00.000Z", ts(4))
	e.sync(tok, syncRequest{Workouts: []WorkoutRow{we}})
	if e.pullWorkouts(tok)[we.key()].Done {
		t.Fatal("没有任何组的那一天，workout.done 应为 false")
	}
}

// 模块设计 §10：三张表混合分页拉取不重不漏。
func TestIntegrationThreeTablePagination(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("threepage")

	const nSet, nWorkout, nMetric = 600, 300, 150
	day := func(i int) string {
		return time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, i).Format("2006-01-02")
	}

	// sets：600 行 = 60 天 × 10 组
	sets := make([]SetRow, 0, nSet)
	for i := 0; i < nSet; i++ {
		sets = append(sets, mkSet(day(i/10), "g1", i%10+1, 50, ts(1)))
	}
	// workouts：300 行 = 300 个不同日期（主键是 user+date）
	workouts := make([]WorkoutRow, 0, nWorkout)
	for i := 0; i < nWorkout; i++ {
		workouts = append(workouts, mkWorkout(day(i), "2024-01-01T10:00:00.000Z", ts(1)))
	}
	// metrics：150 行 = 150 个不同日期
	metrics := make([]MetricRow, 0, nMetric)
	for i := 0; i < nMetric; i++ {
		metrics = append(metrics, MetricRow{
			Kind: "weight", Date: day(5000 + i), Value: 70, Unit: "kg",
			Done: true, UpdatedAt: ts(1),
		})
	}

	// 单批上限 500，分批推
	const batch = 400
	for i := 0; i < len(sets); i += batch {
		j := min(i+batch, len(sets))
		e.sync(tok, syncRequest{Sets: sets[i:j]})
	}
	for i := 0; i < len(workouts); i += batch {
		j := min(i+batch, len(workouts))
		e.sync(tok, syncRequest{Workouts: workouts[i:j]})
	}
	for i := 0; i < len(metrics); i += batch {
		j := min(i+batch, len(metrics))
		e.sync(tok, syncRequest{Metrics: metrics[i:j]})
	}

	// 从游标 0 全量拉，逐页累计
	seenSet := map[string]bool{}
	seenWk := map[string]bool{}
	seenMet := map[string]bool{}
	cur := int64(0)
	pages := 0
	for {
		r := e.sync(tok, syncRequest{Cursor: cur})
		for _, x := range r.Sets {
			if seenSet[x.key()] {
				t.Fatalf("set %s 重复出现", x.key())
			}
			seenSet[x.key()] = true
		}
		for _, x := range r.Workouts {
			if seenWk[x.key()] {
				t.Fatalf("workout %s 重复出现", x.key())
			}
			seenWk[x.key()] = true
		}
		for _, x := range r.Metrics {
			if seenMet[x.key()] {
				t.Fatalf("metric %s 重复出现", x.key())
			}
			seenMet[x.key()] = true
		}
		cur = r.Cursor
		pages++
		if pages > 50 {
			t.Fatal("分页没有终止")
		}
		if !r.HasMore {
			break
		}
	}

	if len(seenSet) != nSet || len(seenWk) != nWorkout || len(seenMet) != nMetric {
		t.Fatalf("三张表分页漏行：sets=%d/%d workouts=%d/%d metrics=%d/%d（共 %d 页）",
			len(seenSet), nSet, len(seenWk), nWorkout, len(seenMet), nMetric, pages)
	}
	if pages < 2 {
		t.Fatalf("总量 %d 应触发多页，实际只用 %d 页", nSet+nWorkout+nMetric, pages)
	}
}

// workouts 按字段合并，合并结果可能和上传方手里的不一样，所以必须回传给上传方。
// 曾经的 bug：沿用 sets 的「赢了就不回传」，后上传但开始得晚的设备永远拿不到较早的 startedAt。
func TestIntegrationWorkoutMergeEchoedToUploader(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("wecho")
	const d = "2026-10-29"

	early := mkWorkout(d, "2026-10-29T10:00:10.000Z", ts(10))
	e.sync(tok, syncRequest{Workouts: []WorkoutRow{early}})
	_, _, cur := e.pullAll(tok)

	late := mkWorkout(d, "2026-10-29T10:00:40.000Z", ts(40))
	r := e.sync(tok, syncRequest{Cursor: cur, Workouts: []WorkoutRow{late}})
	if len(r.Workouts) != 1 {
		t.Fatalf("上传方应收到合并后的 workout，得到 %d 行", len(r.Workouts))
	}
	got, _ := time.Parse(time.RFC3339Nano, r.Workouts[0].StartedAt)
	want, _ := time.Parse(time.RFC3339Nano, early.StartedAt)
	if !got.Equal(want) {
		t.Fatalf("回传的 startedAt 应为较早的 %s，得到 %s", early.StartedAt, r.Workouts[0].StartedAt)
	}
}

// 热身标记：能存能取；旧客户端（不带 warmup）重传不会把它清掉；热身组不算最好成绩。
func TestIntegrationWarmupFlag(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("warmup")
	yes := true

	warm := mkSet("2026-10-29", "g1", 1, 80, ts(1)) // 热身组故意比正式组重，验证 pb 不取它
	warm.Warmup = &yes
	work := mkSet("2026-10-29", "g1", 2, 60, ts(2))
	e.sync(tok, syncRequest{Sets: []SetRow{warm, work}})

	old := warm
	old.Warmup = nil
	old.UpdatedAt = ts(3)
	e.sync(tok, syncRequest{Sets: []SetRow{old}})

	all, _, _ := e.pullAll(tok)
	if w := all[warm.key()].Warmup; w == nil || !*w {
		t.Fatalf("旧客户端重传后热身标记被清掉了: %v", w)
	}

	var sum historySummary
	e.do(tok, "GET", "/api/history/summary", nil, &sum, 200)
	if len(sum.Exercises) != 1 || sum.Exercises[0].PB != 60 {
		t.Fatalf("最好成绩应排除热身组（60），得到 %+v", sum.Exercises)
	}
}

// 训练日程字段（blockId / trackVer）：能存能取；旧客户端（不带这两个字段）重传不会清空。
// 老记录这两列为 null，客户端读取时一律视为 blockId = "main"。
func TestIntegrationBlockFields(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("block")
	block := "t-1761700000000"
	ver := 3

	row := mkSet("2026-10-29", "g1", 1, 50, ts(1))
	row.BlockID = &block
	row.TrackVer = &ver
	e.sync(tok, syncRequest{Sets: []SetRow{row}})

	// 旧客户端：不带 blockId / trackVer，但 updatedAt 更晚、改了重量
	old := mkSet("2026-10-29", "g1", 1, 55, ts(9))
	e.sync(tok, syncRequest{Sets: []SetRow{old}})

	all, _, _ := e.pullAll(tok)
	got := all[row.key()]
	if got.Weight != 55 {
		t.Fatalf("LWW 应让新重量生效，得到 %v", got.Weight)
	}
	if got.BlockID == nil || *got.BlockID != block {
		t.Fatalf("blockId 被旧客户端清空了: %v", got.BlockID)
	}
	if got.TrackVer == nil || *got.TrackVer != ver {
		t.Fatalf("trackVer 被清空了: %v", got.TrackVer)
	}

	// 从没写过这两个字段的记录，读出来必须是 null（客户端据此判断「视为 main」）
	legacy := mkSet("2026-10-29", "g2", 1, 40, ts(2))
	e.sync(tok, syncRequest{Sets: []SetRow{legacy}})
	all2, _, _ := e.pullAll(tok)
	lg := all2[legacy.key()]
	if lg.BlockID != nil || lg.TrackVer != nil {
		t.Fatalf("没传过的字段应为 null，得到 blockId=%v trackVer=%v", lg.BlockID, lg.TrackVer)
	}
}

/* ============ 动作库（E1：自建动作 + 官方清单） ============ */

func mkCustom(id, cn, part string, done bool, at string) CustomExerciseRow {
	return CustomExerciseRow{
		ExID: id, Cn: cn, Part: part, Place: "gym", Unit: "kg",
		Tips: "肩胛下沉", Done: done, UpdatedAt: at,
	}
}

// pullCustom：模拟一台新设备，翻页把自建动作全拉下来
func (e *testEnv) pullCustom(tok string) (map[string]CustomExerciseRow, int64) {
	e.t.Helper()
	got := map[string]CustomExerciseRow{}
	cursor := int64(0)
	for i := 0; i < 100; i++ {
		r := e.sync(tok, syncRequest{Cursor: cursor})
		for _, x := range r.CustomExercises {
			got[x.key()] = x
		}
		cursor = r.Cursor
		if !r.HasMore {
			return got, cursor
		}
	}
	e.t.Fatal("翻页 100 次还没拉完")
	return nil, 0
}

// 自建动作走整行 LWW：新的赢、旧的被挡且回推服务端赢家。
func TestIntegrationCustomExerciseLWW(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("custlww")

	first := mkCustom("u-aaa111", "绳索夹胸", "chest", true, ts(1))
	e.sync(tok, syncRequest{CustomExercises: []CustomExerciseRow{first}})

	// 更新的版本：改名字
	newer := first
	newer.Cn = "绳索夹胸（改良）"
	newer.UpdatedAt = ts(9)
	e.sync(tok, syncRequest{CustomExercises: []CustomExerciseRow{newer}})

	// 更旧的版本：想改回去，应被 LWW 挡住
	older := first
	older.Cn = "旧名字"
	older.UpdatedAt = ts(3)
	r := e.sync(tok, syncRequest{CustomExercises: []CustomExerciseRow{older}})

	got, _ := e.pullCustom(tok)
	x, ok := got[first.key()]
	if !ok {
		t.Fatalf("拉不到自建动作 %s", first.key())
	}
	if x.Cn != "绳索夹胸（改良）" {
		t.Fatalf("LWW 后应是新名字，得到 %q", x.Cn)
	}
	// 落败行要回推服务端赢家，否则时钟偏慢的设备永远停在自己的旧值上
	found := false
	for _, row := range r.CustomExercises {
		if row.ExID == first.ExID && row.Cn == "绳索夹胸（改良）" {
			found = true
		}
	}
	if !found {
		t.Fatalf("落败的行应回推服务端赢家，本次响应里没有：%+v", r.CustomExercises)
	}
}

// 墓碑：done=false 跨设备传播；而且用自建动作记的组照常存，exCn/part 是冗余的真值。
func TestIntegrationCustomExerciseTombstone(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("custtomb")

	ex := mkCustom("u-bbb222", "自建划船", "back", true, ts(1))
	e.sync(tok, syncRequest{CustomExercises: []CustomExerciseRow{ex}})

	// 用这个自建动作记一组：exId 带 u- 前缀、exCn/part 由客户端冗余写进来
	row := mkSet("2026-10-29", "u-bbb222", 1, 40, ts(2))
	row.ExCn = "自建划船"
	row.Part = "back"
	e.sync(tok, syncRequest{Sets: []SetRow{row}})

	// 删除 = 墓碑，不是物理删
	tomb := ex
	tomb.Done = false
	tomb.UpdatedAt = ts(5)
	e.sync(tok, syncRequest{CustomExercises: []CustomExerciseRow{tomb}})

	got, _ := e.pullCustom(tok)
	if x, ok := got[ex.key()]; !ok || x.Done {
		t.Fatalf("墓碑应作为 done=false 下发，得到 %+v（存在=%v）", x, ok)
	}

	// 历史记录不受影响：动作删了，那天记的组还在，名字和部位都还对
	all, _, _ := e.pullAll(tok)
	s, ok := all[row.key()]
	if !ok {
		t.Fatal("删动作不该影响已经记下的组")
	}
	if s.ExCn != "自建划船" || s.Part != "back" {
		t.Fatalf("组的冗余字段走样：exCn=%q part=%q", s.ExCn, s.Part)
	}
}

// 坏行隔离：一条非法自建动作进 rejected，同批合法的照常入库——不能整批失败。
func TestIntegrationCustomExerciseRejected(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("custbad")

	bad := mkCustom("g1", "想冒充官方动作", "chest", true, ts(1)) // 没有 u- 前缀
	badPart := mkCustom("u-ccc333", "部位乱写", "glutes", true, ts(1))
	good := mkCustom("u-ddd444", "合法动作", "arms", true, ts(1))

	r := e.sync(tok, syncRequest{CustomExercises: []CustomExerciseRow{bad, badPart, good}})

	if len(r.Rejected) != 2 {
		t.Fatalf("应有 2 条被拒，得到 %+v", r.Rejected)
	}
	for _, rj := range r.Rejected {
		if rj.Kind != "customExercise" {
			t.Fatalf("rejected.kind 应是 customExercise，得到 %q", rj.Kind)
		}
	}
	if r.Rejected[0].Index != 0 || r.Rejected[1].Index != 1 {
		t.Fatalf("rejected.index 应是请求数组下标 0/1，得到 %d/%d", r.Rejected[0].Index, r.Rejected[1].Index)
	}

	got, _ := e.pullCustom(tok)
	if len(got) != 1 {
		t.Fatalf("合法的 1 条应入库，得到 %d 条", len(got))
	}
	if _, ok := got[good.key()]; !ok {
		t.Fatal("合法的那条没存下来")
	}
}

// rev 区间不多不少：同一批里混了 sets + 自建动作 + 配置，
// 参与分配的条数（push 里的 n）漏算任何一个，多出来的行就会拿到区间外的 rev，
// 被 cursor 永久跳过——数据静默丢失，只有这条测试能发现。
func TestIntegrationCustomExerciseRevRange(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("custrev")

	sets := []SetRow{
		mkSet("2026-10-27", "g1", 1, 60, ts(1)),
		mkSet("2026-10-28", "g2", 1, 40, ts(2)),
	}
	exs := []CustomExerciseRow{
		mkCustom("u-e1", "动作一", "chest", true, ts(1)),
		mkCustom("u-e2", "动作二", "back", true, ts(2)),
		mkCustom("u-e3", "动作三", "legs", true, ts(3)),
	}
	cfg := &ConfigDoc{Body: []byte(`{"v":1}`), UpdatedAt: ts(1)}

	e.sync(tok, syncRequest{Sets: sets, CustomExercises: exs, Config: cfg})

	// 从 0 全量拉：四类都要到齐
	allSets, _, _ := e.pullAll(tok)
	allEx, _ := e.pullCustom(tok)
	if len(allSets) != len(sets) {
		t.Fatalf("sets 应拉回 %d 条，得到 %d", len(sets), len(allSets))
	}
	if len(allEx) != len(exs) {
		t.Fatalf("自建动作应拉回 %d 条，得到 %d（rev 区间漏算的典型症状）", len(exs), len(allEx))
	}

	// 再推一批只有自建动作的，确认连续分配没断档
	more := mkCustom("u-e4", "动作四", "core", true, ts(9))
	e.sync(tok, syncRequest{Cursor: 0, CustomExercises: []CustomExerciseRow{more}})
	allEx2, _ := e.pullCustom(tok)
	if len(allEx2) != 4 {
		t.Fatalf("第二批之后应有 4 条，得到 %d", len(allEx2))
	}
}

// 四张表混合分页：动作库把三路归并扩到四路，最容易漏的是自建动作那一路。
func TestIntegrationFourTablePagination(t *testing.T) {
	e := newTestEnv(t)
	tok := e.login("fourpage")

	const nSet, nWorkout, nMetric, nCustom = 500, 200, 100, 400
	day := func(i int) string {
		return time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, i).Format("2006-01-02")
	}

	var sets []SetRow
	for i := 0; i < nSet; i++ {
		sets = append(sets, mkSet(day(i/10), "g1", i%10+1, 50, ts(1)))
	}
	var workouts []WorkoutRow
	for i := 0; i < nWorkout; i++ {
		workouts = append(workouts, mkWorkout(day(i), "2024-03-01T10:00:00.000Z", ts(1)))
	}
	var metrics []MetricRow
	for i := 0; i < nMetric; i++ {
		metrics = append(metrics, MetricRow{Kind: "weight", Date: day(3000 + i), Value: 70,
			Unit: "kg", Done: true, UpdatedAt: ts(1)})
	}
	var exs []CustomExerciseRow
	for i := 0; i < nCustom; i++ {
		exs = append(exs, mkCustom("u-p"+itoa(i), "动作"+itoa(i), "chest", true, ts(1)))
	}

	const batch = 400
	push := func(req syncRequest) {
		if err := req.pushInBatches(e, tok, batch); err != nil {
			t.Fatal(err)
		}
	}
	push(syncRequest{Sets: sets})
	push(syncRequest{Workouts: workouts})
	push(syncRequest{Metrics: metrics})
	push(syncRequest{CustomExercises: exs})

	seenSet := map[string]bool{}
	seenWk := map[string]bool{}
	seenMet := map[string]bool{}
	seenEx := map[string]bool{}
	cur := int64(0)
	pages := 0
	for {
		r := e.sync(tok, syncRequest{Cursor: cur})
		for _, x := range r.Sets {
			if seenSet[x.key()] {
				t.Fatalf("set %s 重复出现", x.key())
			}
			seenSet[x.key()] = true
		}
		for _, x := range r.Workouts {
			if seenWk[x.key()] {
				t.Fatalf("workout %s 重复出现", x.key())
			}
			seenWk[x.key()] = true
		}
		for _, x := range r.Metrics {
			if seenMet[x.key()] {
				t.Fatalf("metric %s 重复出现", x.key())
			}
			seenMet[x.key()] = true
		}
		for _, x := range r.CustomExercises {
			if seenEx[x.key()] {
				t.Fatalf("自建动作 %s 重复出现", x.key())
			}
			seenEx[x.key()] = true
		}
		cur = r.Cursor
		pages++
		if pages > 50 {
			t.Fatal("分页没有终止")
		}
		if !r.HasMore {
			break
		}
	}

	if len(seenSet) != nSet || len(seenWk) != nWorkout || len(seenMet) != nMetric || len(seenEx) != nCustom {
		t.Fatalf("四表分页漏行：sets=%d/%d workouts=%d/%d metrics=%d/%d custom=%d/%d（%d 页）",
			len(seenSet), nSet, len(seenWk), nWorkout, len(seenMet), nMetric, len(seenEx), nCustom, pages)
	}
	if pages < 2 {
		t.Fatalf("总量 %d 应触发多页，实际只用 %d 页", nSet+nWorkout+nMetric+nCustom, pages)
	}
}

// pushInBatches：把一批行按服务端上限分批推出去（其余字段为空）
func (req syncRequest) pushInBatches(e *testEnv, tok string, batch int) error {
	slices := []struct {
		name string
		fn   func(from, to int) syncRequest
		rows int
	}{
		{"sets", func(f, t int) syncRequest { return syncRequest{Sets: req.Sets[f:t]} }, len(req.Sets)},
		{"workouts", func(f, t int) syncRequest { return syncRequest{Workouts: req.Workouts[f:t]} }, len(req.Workouts)},
		{"metrics", func(f, t int) syncRequest { return syncRequest{Metrics: req.Metrics[f:t]} }, len(req.Metrics)},
		{"custom", func(f, t int) syncRequest {
			return syncRequest{CustomExercises: req.CustomExercises[f:t]}
		}, len(req.CustomExercises)},
	}
	for _, s := range slices {
		for i := 0; i < s.rows; i += batch {
			j := min(i+batch, s.rows)
			e.sync(tok, s.fn(i, j))
		}
	}
	return nil
}

// 官方动作库：整份下发 + since 304 + 详情要登录。
func TestIntegrationCatalog(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()

	// 测试库里直接插内容（生产走 cmd/seed-catalog）
	_, err := e.st.pool.Exec(ctx, `
insert into exercises (id, cn, en, part, place, unit, tips, hot, steps, retired) values
  ('g1',  '卧推',   'Bench Press', 'chest', 'gym',  'kg', '肩胛下沉', true,  '["躺下","握杠","下放"]', false),
  ('h900','俯卧撑', 'Push-up',     'chest', 'home', 'bw', '身体一条线', false, '[]', false),
  ('g900','下架动作','Retired',    'chest', 'gym',  'kg', '',           false, '[]', true)
on conflict (id) do update set cn = excluded.cn, hot = excluded.hot, retired = excluded.retired`)
	if err != nil {
		t.Fatalf("插入官方动作: %v", err)
	}
	var rev int64
	if err := e.st.pool.QueryRow(ctx, `update catalog_meta set rev = rev + 1 where id = 1 returning rev`).Scan(&rev); err != nil {
		t.Fatalf("推进 catalog_rev: %v", err)
	}

	// 1. 整份下发（免登录）
	var cat catalogResponse
	e.do("", "GET", "/api/catalog", nil, &cat, 200)
	if cat.Rev != rev {
		t.Fatalf("rev 应为 %d，得到 %d", rev, cat.Rev)
	}
	if len(cat.Exercises) < 3 {
		t.Fatalf("应至少下发 3 条（含 retired），得到 %d", len(cat.Exercises))
	}
	// 顺序由服务端定：hot 在前
	hotIdx, coldIdx := -1, -1
	for i, x := range cat.Exercises {
		switch {
		case x.ID == "g1" && hotIdx < 0:
			hotIdx = i
		case x.ID == "h900" && coldIdx < 0:
			coldIdx = i
		}
	}
	if hotIdx < 0 || coldIdx < 0 || hotIdx > coldIdx {
		t.Fatalf("hot 动作应排在前面：g1@%d h900@%d", hotIdx, coldIdx)
	}
	// retired 的行也要下发，由客户端过滤（整份替换才能覆盖本地旧的「未下架」）
	foundRetired := false
	for _, x := range cat.Exercises {
		if x.ID == "g900" && x.Retired {
			foundRetired = true
		}
	}
	if !foundRetired {
		t.Fatal("retired=true 的行也必须整份下发")
	}

	// 2. since >= rev → 304，客户端什么都不做
	e.do("", "GET", "/api/catalog?since="+itoa64(rev), nil, nil, http.StatusNotModified)
	// 3. since < rev → 整份
	e.do("", "GET", "/api/catalog?since=0", nil, &cat, 200)
	// 4. since 非法 → 400
	var eb errBody
	e.do("", "GET", "/api/catalog?since=abc", nil, &eb, 400)

	// 5. 详情要登录；steps 是 string[]
	tok := e.login("catalogdetail")
	var d exerciseDetail
	e.do(tok, "GET", "/api/exercises/g1", nil, &d, 200)
	if d.ID != "g1" || len(d.Steps) != 3 || d.Steps[0] != "躺下" {
		t.Fatalf("详情不对：%+v", d)
	}
	// 未登录 → 401
	e.do("", "GET", "/api/exercises/g1", nil, &eb, http.StatusUnauthorized)
	// 不存在 → 404
	e.do(tok, "GET", "/api/exercises/g404", nil, &eb, 404)

	// 6. /sync 响应里带 catalogRev，客户端据此判断要不要拉清单
	r := e.sync(tok, syncRequest{Cursor: 0})
	if r.CatalogRev != rev {
		t.Fatalf("/sync 的 catalogRev 应为 %d，得到 %d", rev, r.CatalogRev)
	}
}
