package main

import (
	"encoding/json"
	"testing"
	"time"
)

/* ---------------- 客户端时刻 ---------------- */

func TestClientTime(t *testing.T) {
	now := time.Date(2026, 10, 29, 10, 0, 0, 0, time.UTC)

	t.Run("JS toISOString 的毫秒格式原样采纳", func(t *testing.T) {
		got, ok := clientTime("2026-10-29T09:12:03.123Z", now)
		want := time.Date(2026, 10, 29, 9, 12, 3, 123e6, time.UTC)
		if !ok || !got.Equal(want) {
			t.Fatalf("期望 %v，得到 %v ok=%v", want, got, ok)
		}
	})

	t.Run("带时区偏移的统一转 UTC", func(t *testing.T) {
		got, ok := clientTime("2026-10-29T17:00:00+08:00", now)
		if !ok || !got.Equal(time.Date(2026, 10, 29, 9, 0, 0, 0, time.UTC)) {
			t.Fatalf("得到 %v", got)
		}
	})

	t.Run("比服务器快 2 分钟以内：照收", func(t *testing.T) {
		in := now.Add(90 * time.Second)
		got, _ := clientTime(in.Format(time.RFC3339Nano), now)
		if !got.Equal(in) {
			t.Fatalf("不该被夹紧: %v", got)
		}
	})

	t.Run("比服务器快太多：夹到服务器时间，不能永远赢 LWW", func(t *testing.T) {
		got, ok := clientTime("2027-01-01T00:00:00Z", now)
		if !ok || !got.Equal(now) {
			t.Fatalf("应夹紧到 %v，得到 %v", now, got)
		}
	})

	t.Run("缺失或非法：拒收，不能拿 now() 顶替", func(t *testing.T) {
		for _, in := range []string{"", "昨天", "2026-10-29"} {
			if _, ok := clientTime(in, now); ok {
				t.Fatalf("%q 应该被拒", in)
			}
		}
	})
}

/* ---------------- 校验 ---------------- */

func TestValidateSet(t *testing.T) {
	good := SetRow{Date: "2026-10-29", ExID: "g1", SetNo: 1, Unit: "kg", Weight: 50, Reps: 10,
		ExCn: "卧推", Part: "chest", PlanKey: "A", Sig: "some|3|gym|auto"}
	if r := validateSet(&good); r != "" {
		t.Fatalf("合法行被拒: %s", r)
	}

	bad := map[string]func(*SetRow){
		"日期格式":   func(r *SetRow) { r.Date = "2026/10/29" },
		"不存在的日期": func(r *SetRow) { r.Date = "2026-02-30" },
		"空 exId": func(r *SetRow) { r.ExID = "" },
		"组号 0":   func(r *SetRow) { r.SetNo = 0 },
		"组号过大":   func(r *SetRow) { r.SetNo = 51 },
		"未知单位":   func(r *SetRow) { r.Unit = "lb" },
		"负重量":    func(r *SetRow) { r.Weight = -1 },
		"离谱重量":   func(r *SetRow) { r.Weight = 5000 },
		"中文名过长":  func(r *SetRow) { r.ExCn = string(make([]rune, 33)) },
	}
	for name, mut := range bad {
		row := good
		mut(&row)
		if validateSet(&row) == "" {
			t.Errorf("%s：应该被拒", name)
		}
	}
}

func TestValidateConfig(t *testing.T) {
	ok := ConfigDoc{Body: json.RawMessage(`{"profile":{"days":3}}`)}
	if r := validateConfig(&ok); r != "" {
		t.Fatalf("合法配置被拒: %s", r)
	}
	for _, body := range []string{``, `[]`, `"x"`, `{bad`, `null`} {
		c := ConfigDoc{Body: json.RawMessage(body)}
		if validateConfig(&c) == "" {
			t.Errorf("%q 应该被拒", body)
		}
	}
	big := make([]byte, maxConfigBytes+10)
	for i := range big {
		big[i] = ' '
	}
	copy(big, `{"a":"`)
	copy(big[len(big)-2:], `"}`)
	for i := 6; i < len(big)-2; i++ {
		big[i] = 'x'
	}
	c := ConfigDoc{Body: big}
	if validateConfig(&c) == "" {
		t.Error("超过 64KB 应该被拒")
	}
}

/* ---------------- 拉增量分页 ---------------- */

func setsWithRevs(revs ...int64) []SetRow {
	out := []SetRow{}
	for _, r := range revs {
		out = append(out, SetRow{ExID: "g1", rev: r})
	}
	return out
}

func metricsWithRevs(revs ...int64) []MetricRow {
	out := []MetricRow{}
	for _, r := range revs {
		out = append(out, MetricRow{Kind: "weight", rev: r})
	}
	return out
}

func TestPagePull(t *testing.T) {
	t.Run("没取满 → 一次拿全，游标跳到 userRev（跳过空洞）", func(t *testing.T) {
		s, _, m, cur, more := pagePull(setsWithRevs(3, 5), nil, metricsWithRevs(4), 10, 9)
		if len(s) != 2 || len(m) != 1 || cur != 9 || more {
			t.Fatalf("得到 sets=%d metrics=%d cursor=%d more=%v", len(s), len(m), cur, more)
		}
	})

	t.Run("什么都没有 → 游标仍前进到 userRev", func(t *testing.T) {
		_, _, _, cur, more := pagePull(nil, nil, nil, 10, 42)
		if cur != 42 || more {
			t.Fatalf("cursor=%d more=%v", cur, more)
		}
	})

	t.Run("一张表取满 → 按 rev 归并截断，游标停在最后一条", func(t *testing.T) {
		// limit=3：sets 取回 1,2,6（满了），metrics 取回 3,4
		s, _, m, cur, more := pagePull(setsWithRevs(1, 2, 6), nil, metricsWithRevs(3, 4), 3, 100)
		if !more || cur != 3 {
			t.Fatalf("cursor=%d more=%v", cur, more)
		}
		if len(s) != 2 || len(m) != 1 {
			t.Fatalf("应返回 rev 1,2,3：sets=%d metrics=%d", len(s), len(m))
		}
	})

	t.Run("被截掉的行 rev 都大于新游标 → 下一页一定取得到", func(t *testing.T) {
		sets := setsWithRevs(1, 3, 5, 7)
		metrics := metricsWithRevs(2, 4, 6, 8)
		_, _, _, cur, _ := pagePull(sets, nil, metrics, 4, 100)
		for _, r := range append(setsWithRevs(5, 7), SetRow{rev: 6}, SetRow{rev: 8}) {
			if r.rev <= cur {
				t.Fatalf("rev %d 被截掉但不大于游标 %d，会永久漏掉", r.rev, cur)
			}
		}
	})

	t.Run("三张表混合 → 仍按 rev 升序归并，不重不漏", func(t *testing.T) {
		sets := setsWithRevs(1, 4, 7)
		workouts := workoutsWithRevs(2, 5, 8)
		metrics := metricsWithRevs(3, 6, 9)
		s, wk, m, cur, more := pagePull(sets, workouts, metrics, 5, 100)

		total := len(s) + len(wk) + len(m)
		if total != 5 || !more {
			t.Fatalf("应返回 5 条且 more=true，得到 %d 条 more=%v", total, more)
		}
		if cur != 5 {
			t.Fatalf("游标应停在最后一条的 rev=5，得到 %d", cur)
		}
		// rev 1,2,3,4,5 → sets 1,4 / workouts 2,5 / metrics 3
		if len(s) != 2 || len(wk) != 2 || len(m) != 1 {
			t.Fatalf("归并结果不对：sets=%d workouts=%d metrics=%d", len(s), len(wk), len(m))
		}
	})
}

func workoutsWithRevs(revs ...int64) []WorkoutRow {
	out := make([]WorkoutRow, 0, len(revs))
	for _, r := range revs {
		out = append(out, WorkoutRow{Date: "2026-10-31", rev: r})
	}
	return out
}

/* ---------------- 一次训练的校验 ---------------- */

func TestValidateWorkout(t *testing.T) {
	base := func() WorkoutRow {
		return WorkoutRow{
			Date:      "2026-10-31",
			PlanKey:   "B",
			PlanName:  "拉日",
			Sig:       "some|3|gym|gym-ppl-3",
			ProgramID: "gym-ppl-3",
			StartedAt: "2026-10-31T11:02:15.120Z",
			Note:      "",
			UpdatedAt: "2026-10-31T11:48:40.002Z",
		}
	}
	ptrInt := func(i int) *int { return &i }
	ptrStr := func(s string) *string { return &s }

	t.Run("最小合法行", func(t *testing.T) {
		r := base()
		if got := validateWorkout(&r); got != "" {
			t.Fatalf("不该报错: %s", got)
		}
	})

	t.Run("startedAt 必填", func(t *testing.T) {
		r := base()
		r.StartedAt = ""
		if validateWorkout(&r) == "" {
			t.Fatal("缺 startedAt 应该报错")
		}
	})

	t.Run("startedAt 必须是 RFC3339", func(t *testing.T) {
		r := base()
		r.StartedAt = "2026-10-31 11:02"
		if validateWorkout(&r) == "" {
			t.Fatal("格式错应该报错")
		}
	})

	t.Run("finishedAt 可空", func(t *testing.T) {
		r := base()
		r.FinishedAt = nil
		if got := validateWorkout(&r); got != "" {
			t.Fatalf("不该报错: %s", got)
		}
	})

	t.Run("finishedAt 不能早于 startedAt", func(t *testing.T) {
		r := base()
		r.FinishedAt = ptrStr("2026-10-31T10:00:00.000Z")
		if validateWorkout(&r) == "" {
			t.Fatal("结束早于开始应该报错")
		}
	})

	t.Run("feel 只能 1–5", func(t *testing.T) {
		r := base()
		r.Feel = ptrInt(6)
		if validateWorkout(&r) == "" {
			t.Fatal("feel=6 应该报错")
		}
		r.Feel = ptrInt(3)
		if got := validateWorkout(&r); got != "" {
			t.Fatalf("feel=3 不该报错: %s", got)
		}
	})

	t.Run("note 超过 200 字报错", func(t *testing.T) {
		r := base()
		long := make([]rune, 201)
		for i := range long {
			long[i] = '练'
		}
		r.Note = string(long)
		if validateWorkout(&r) == "" {
			t.Fatal("note 超长应该报错")
		}
	})
}

func TestValidateSetNewFields(t *testing.T) {
	base := func() SetRow {
		return SetRow{
			Date: "2026-10-31", ExID: "g1", SetNo: 1, Unit: "kg",
			Weight: 50, Reps: 10, UpdatedAt: "2026-10-31T11:02:15.120Z",
		}
	}
	ptrInt := func(i int) *int { return &i }
	ptrF := func(f float64) *float64 { return &f }
	ptrStr := func(s string) *string { return &s }

	t.Run("新字段全空 → 旧版客户端照常通过", func(t *testing.T) {
		r := base()
		if got := validateSet(&r); got != "" {
			t.Fatalf("不该报错: %s", got)
		}
	})

	t.Run("新字段全填 → 通过", func(t *testing.T) {
		r := base()
		r.Slot = ptrInt(2)
		r.Rir = ptrInt(2)
		r.Assist = ptrF(10)
		r.TargetWeight = ptrF(52.5)
		r.TargetReps = ptrInt(10)
		r.TargetSets = ptrInt(4)
		r.CompletedAt = ptrStr("2026-10-31T11:05:00.000Z")
		if got := validateSet(&r); got != "" {
			t.Fatalf("不该报错: %s", got)
		}
	})

	t.Run("slot / rir / targetSets 越界", func(t *testing.T) {
		for name, apply := range map[string]func(*SetRow){
			"slot=-1":      func(r *SetRow) { r.Slot = ptrInt(-1) },
			"slot=20":      func(r *SetRow) { r.Slot = ptrInt(20) },
			"rir=11":       func(r *SetRow) { r.Rir = ptrInt(11) },
			"targetSets=0": func(r *SetRow) { r.TargetSets = ptrInt(0) },
		} {
			r := base()
			apply(&r)
			if validateSet(&r) == "" {
				t.Fatalf("%s 应该报错", name)
			}
		}
	})

	t.Run("completedAt 格式错", func(t *testing.T) {
		r := base()
		r.CompletedAt = ptrStr("2026/10/31 11:05")
		if validateSet(&r) == "" {
			t.Fatal("格式错应该报错")
		}
	})
}

/* ---------------- 限流 ---------------- */

func TestLimiter(t *testing.T) {
	l := &limiter{rate: 1, burst: 3, buckets: map[string]*bucket{}}
	now := time.Now()

	for i := 0; i < 3; i++ {
		if !l.allow("u1", now) {
			t.Fatalf("突发额度内第 %d 次被拒", i+1)
		}
	}
	if l.allow("u1", now) {
		t.Fatal("超出突发额度应该被拒")
	}
	if !l.allow("u2", now) {
		t.Fatal("别的用户不该受影响")
	}
	if !l.allow("u1", now.Add(1100*time.Millisecond)) {
		t.Fatal("过 1 秒应该补回 1 个令牌")
	}
}

/* ---------------- streak ---------------- */

func TestStreakFrom(t *testing.T) {
	loc := time.FixedZone("CST", 8*3600)
	day := func(s string) string { return s }

	base := time.Date(2026, 10, 29, 9, 0, 0, 0, loc) // 默认基准：当天 09:00

	cases := []struct {
		name string
		days map[string]bool
		now  time.Time // 零值则用 base
		want int
	}{
		{
			name: "今天练了 → 含今天",
			days: map[string]bool{day("2026-10-29"): true, day("2026-10-28"): true, day("2026-10-27"): true},
			want: 3,
		},
		{
			name: "今天没练但昨天练了 → 从昨天数，不算断签",
			days: map[string]bool{day("2026-10-28"): true, day("2026-10-27"): true},
			want: 2,
		},
		{
			name: "中间断了一天 → 只数到断点",
			days: map[string]bool{
				"2026-10-29": true,
				"2026-10-28": true,
				"2026-10-26": true, // 10-27 缺
			},
			want: 2,
		},
		{
			name: "今天和昨天都没练 → 0",
			days: map[string]bool{"2026-10-26": true},
			want: 0,
		},
		{
			name: "一条记录都没有 → 0",
			days: map[string]bool{},
			want: 0,
		},
		{
			name: "跨月连续（11-02 往回数到 10-30）",
			days: map[string]bool{
				"2026-11-02": true,
				"2026-11-01": true,
				"2026-10-31": true,
				"2026-10-30": true,
			},
			now:  time.Date(2026, 11, 2, 9, 0, 0, 0, loc),
			want: 4,
		},
		{
			name: "未来日期的记录不算进来",
			days: map[string]bool{
				"2026-10-29": true,
				"2026-10-30": true, // 明天，不该算
				"2026-11-01": true,
			},
			want: 1,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			now := c.now
			if now.IsZero() {
				now = base
			}
			if got := streakFrom(c.days, now); got != c.want {
				t.Fatalf("期望 %d，得到 %d", c.want, got)
			}
		})
	}
}

/* ---------------- 其它 ---------------- */

func TestNullableStr(t *testing.T) {
	if nullableStr("") != nil {
		t.Fatal("空串应该变成 NULL")
	}
	if p := nullableStr("2026-10-01"); p == nil || *p != "2026-10-01" {
		t.Fatal("非空串应该原样返回")
	}
}

func TestLoadConfigRequiresDSN(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("没有 DATABASE_URL 应该报错")
	}
}

func TestLoadConfigDevModeNoWeChatCreds(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x/y")
	t.Setenv("DEV_MODE", "true")
	t.Setenv("WECHAT_APPID", "")
	t.Setenv("WECHAT_SECRET", "")
	t.Setenv("TZ_NAME", "Asia/Shanghai")

	c, err := loadConfig()
	if err != nil {
		t.Fatalf("DEV_MODE 下不该要求微信凭证: %v", err)
	}
	if c.loc == nil {
		t.Fatal("时区未加载")
	}
}

func TestLoadConfigProdRejectsDefaultSecret(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x/y")
	t.Setenv("DEV_MODE", "false")
	t.Setenv("WECHAT_APPID", "wx123")
	t.Setenv("WECHAT_SECRET", "s")

	t.Setenv("JWT_SECRET", "")
	if _, err := loadConfig(); err == nil {
		t.Fatal("生产环境用默认 JWT_SECRET 应该拒绝启动")
	}
	t.Setenv("JWT_SECRET", "short")
	if _, err := loadConfig(); err == nil {
		t.Fatal("生产环境 JWT_SECRET 太短应该拒绝启动")
	}
	t.Setenv("JWT_SECRET", "0123456789abcdef0123456789abcdef")
	if _, err := loadConfig(); err != nil {
		t.Fatalf("合格配置不该报错: %v", err)
	}
}

func TestLoadConfigProdRequiresWeChatCreds(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x/y")
	t.Setenv("DEV_MODE", "false")
	t.Setenv("WECHAT_APPID", "")
	t.Setenv("WECHAT_SECRET", "")

	if _, err := loadConfig(); err == nil {
		t.Fatal("非 DEV_MODE 且没有微信凭证，应该报错")
	}
}
