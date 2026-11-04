package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

type store struct {
	pool *pgxpool.Pool
}

func newStore(ctx context.Context, dsn string, maxConns int32) (*store, error) {
	pc, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("解析 DATABASE_URL: %w", err)
	}
	if maxConns > 0 {
		pc.MaxConns = maxConns
	}
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, fmt.Errorf("连接数据库: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("数据库不可达: %w", err)
	}
	return &store{pool: pool}, nil
}

func (s *store) close() { s.pool.Close() }

func (s *store) ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// migrate 幂等建表（schema.sql 全用 IF NOT EXISTS）。
// 多实例同时启动时用 advisory lock 串行化，避免并发 DDL 互相打架。
func (s *store) migrate(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	const lockID = 7_100_201 // 任意常数，只要全库唯一
	if _, err := conn.Exec(ctx, `select pg_advisory_lock($1)`, lockID); err != nil {
		return fmt.Errorf("拿迁移锁: %w", err)
	}
	defer conn.Exec(context.Background(), `select pg_advisory_unlock($1)`, lockID)

	if _, err := conn.Exec(ctx, schemaSQL); err != nil {
		return fmt.Errorf("建表: %w", err)
	}
	return nil
}

func rfc3339(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

/* ---------------- 用户 ---------------- */

func (s *store) upsertUserByOpenID(ctx context.Context, openid string) (int64, error) {
	// do update 而不是 do nothing：do nothing 在命中冲突时不返回行
	const q = `
insert into users (openid) values ($1)
on conflict (openid) do update set openid = excluded.openid
returning id`
	var id int64
	err := s.pool.QueryRow(ctx, q, openid).Scan(&id)
	return id, err
}

/* ---------------- 推：写入一批变更 ---------------- */

// 带上已经解析好的客户端时刻，store 层不再碰字符串时间
type setIn struct {
	SetRow
	at time.Time
}

// workoutIn：started_at / finished_at 直接带客户端的 RFC3339 字符串，
// 由 SQL 里的 ::text::timestamptz 转换。
// 不能传 time.Time —— 参数被声明为 text 时，pgx 会用 Go 的默认格式
// "2006-01-02 15:04:05 +0000 UTC" 编码，Postgres 解析不了（SQLSTATE 22007）。
type workoutIn struct {
	WorkoutRow
	at time.Time
}

type metricIn struct {
	MetricRow
	at time.Time
}

type customExerciseIn struct {
	CustomExerciseRow
	at time.Time
}

type configIn struct {
	ConfigDoc
	at time.Time
}

type pushResult struct {
	applied int
	// won：客户端版本赢下 LWW 的行 → 分到的 rev。
	// 拉增量时这些行原样不回传（客户端手里就是这份），省一半流量。
	won map[string]int64
}

// LWW：只有客户端时刻更新时才覆盖。输了的行不报错，见 bumpSetSQL。
//
// 训练记录模块新增的 7 个可空字段用 coalesce 合并：
// 旧版客户端不传这些字段（null），不能把新客户端已经写上来的值清掉。
const upsertSetSQL = `
insert into sets (user_id, date, ex_id, set_no, ex_cn, part, plan_key, sig,
                  weight, reps, unit, done, updated_at, rev,
                  slot, rir, assist, target_weight, target_reps, target_sets, completed_at, warmup,
                  block_id, track_ver)
values ($1, $2::text::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21::text::timestamptz, $22, $23, $24)
on conflict (user_id, date, ex_id, set_no) do update set
  ex_cn         = excluded.ex_cn,
  part          = excluded.part,
  plan_key      = excluded.plan_key,
  sig           = excluded.sig,
  weight        = excluded.weight,
  reps          = excluded.reps,
  unit          = excluded.unit,
  done          = excluded.done,
  slot          = coalesce(excluded.slot,          sets.slot),
  rir           = coalesce(excluded.rir,           sets.rir),
  assist        = coalesce(excluded.assist,        sets.assist),
  target_weight = coalesce(excluded.target_weight, sets.target_weight),
  target_reps   = coalesce(excluded.target_reps,   sets.target_reps),
  target_sets   = coalesce(excluded.target_sets,   sets.target_sets),
  completed_at  = coalesce(excluded.completed_at,  sets.completed_at),
  warmup        = coalesce(excluded.warmup,        sets.warmup),
  block_id      = coalesce(excluded.block_id,      sets.block_id),
  track_ver     = coalesce(excluded.track_ver,     sets.track_ver),
  updated_at    = excluded.updated_at,
  rev           = excluded.rev
where sets.updated_at < excluded.updated_at`

// workouts 按字段合并，不是整行 LWW（模块设计 §6.2）。
//
// 两台设备同一天都练过时，整行 LWW 会丢掉较早的开始时刻：
//
//	started_at  取较早的     —— 训练从什么时候开始，不该被晚到的上传改晚
//	finished_at 取较晚的     —— 结束时刻同理
//	其余字段    按 updated_at LWW
//	done        不在这里合并 —— 同一事务里按 sets 重新计算（见 refreshWorkoutDone）
//
// 这些规则与到达顺序无关，所以各设备最终结果一致。
const upsertWorkoutSQL = `
insert into workouts (user_id, date, plan_key, plan_name, sig, program_id,
                      started_at, finished_at, feel, note, done, updated_at, rev)
values ($1, $2::text::date, $3, $4, $5, $6, $7::text::timestamptz, $8::text::timestamptz,
        $9, $10, $11, $12, $13)
on conflict (user_id, date) do update set
  started_at  = least(workouts.started_at, excluded.started_at),
  finished_at = case
                  when workouts.finished_at is null then excluded.finished_at
                  when excluded.finished_at is null then workouts.finished_at
                  else greatest(workouts.finished_at, excluded.finished_at)
                end,
  plan_key    = case when excluded.updated_at > workouts.updated_at then excluded.plan_key   else workouts.plan_key   end,
  plan_name   = case when excluded.updated_at > workouts.updated_at then excluded.plan_name  else workouts.plan_name  end,
  sig         = case when excluded.updated_at > workouts.updated_at then excluded.sig        else workouts.sig        end,
  program_id  = case when excluded.updated_at > workouts.updated_at then excluded.program_id else workouts.program_id end,
  feel        = case when excluded.updated_at > workouts.updated_at then excluded.feel       else workouts.feel       end,
  note        = case when excluded.updated_at > workouts.updated_at then excluded.note       else workouts.note       end,
  updated_at  = greatest(workouts.updated_at, excluded.updated_at),
  rev         = excluded.rev`

// 哪些日期的 workouts.done 需要变：以 sets 为准（模块设计 §4.4 / §6.2）。
const workoutDoneDiffSQL = `
select w.date::text, w.done,
       exists (select 1 from sets s
               where s.user_id = w.user_id and s.date = w.date and s.done) as should
from workouts w
where w.user_id = $1 and w.date = any($2::text[]::date[])`

const workoutDoneSetSQL = `
update workouts w
set done = exists (select 1 from sets s
                   where s.user_id = w.user_id and s.date = w.date and s.done),
    rev  = $3
where w.user_id = $1 and w.date = $2::text::date`

// 输掉 LWW 的行也要换一个新 rev：这样它会出现在本次的拉取结果里，
// 客户端拿到的是服务端的赢家版本，而不是留着自己那份旧的。没有这一步，
// 时钟偏慢的设备会永远停在自己的旧值上（它的游标已经越过了赢家原来的 rev）。
const bumpSetSQL = `
update sets set rev = $5
where user_id = $1 and date = $2::text::date and ex_id = $3 and set_no = $4`

const upsertMetricSQL = `
insert into metrics (user_id, kind, date, value, unit, note, done, updated_at, rev)
values ($1, $2, $3::text::date, $4, $5, $6, $7, $8, $9)
on conflict (user_id, kind, date) do update set
  value      = excluded.value,
  unit       = excluded.unit,
  note       = excluded.note,
  done       = excluded.done,
  updated_at = excluded.updated_at,
  rev        = excluded.rev
where metrics.updated_at < excluded.updated_at`

const bumpMetricSQL = `
update metrics set rev = $4
where user_id = $1 and kind = $2 and date = $3::text::date`

const upsertConfigSQL = `
insert into user_config (user_id, body, updated_at, rev)
values ($1, $2::text::jsonb, $3, $4)
on conflict (user_id) do update set
  body       = excluded.body,
  updated_at = excluded.updated_at,
  rev        = excluded.rev
where user_config.updated_at < excluded.updated_at`

const bumpConfigSQL = `update user_config set rev = $2 where user_id = $1`

// 自建动作：和 sets 同一套 LWW（整行覆盖，没有可空字段，所以不需要 coalesce）。
const upsertCustomExerciseSQL = `
insert into user_exercises (user_id, ex_id, cn, part, place, unit, tips, done, updated_at, rev)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
on conflict (user_id, ex_id) do update set
  cn         = excluded.cn,
  part       = excluded.part,
  place      = excluded.place,
  unit       = excluded.unit,
  tips       = excluded.tips,
  done       = excluded.done,
  updated_at = excluded.updated_at,
  rev        = excluded.rev
where user_exercises.updated_at < excluded.updated_at`

const bumpCustomExerciseSQL = `
update user_exercises set rev = $3 where user_id = $1 and ex_id = $2`

// push 在一个事务里写入一批变更。
//
// 并发模型：先 `update users set rev = rev + n` —— 这一句同时做两件事：
//  1. 一次性为这批行分配 n 个连续版本号；
//  2. 锁住该用户那一行直到提交。同一用户的并发写因此串行，
//     保证「rev 小的一定先提交」，拉增量的游标才不会跳过还没提交的行。
//
// 不同用户之间互不阻塞。
func (s *store) push(ctx context.Context, uid int64, sets []setIn, workouts []workoutIn, metrics []metricIn,
	exercises []customExerciseIn, cfg *configIn) (pushResult, error) {

	res := pushResult{won: map[string]int64{}}
	// 这个 n 必须覆盖下面每一条 alloc()：漏算会让多出来的行拿到区间外的 rev，
	// 拉增量时就永远跳不到它（cursor 已经越过），数据静默丢失。
	n := len(sets) + len(workouts) + len(metrics) + len(exercises)
	if cfg != nil {
		n++
	}
	if n == 0 {
		return res, nil
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer tx.Rollback(ctx)

	var end int64
	if err := tx.QueryRow(ctx, `update users set rev = rev + $2 where id = $1 returning rev`, uid, n).Scan(&end); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return res, errUserGone
		}
		return res, fmt.Errorf("分配版本号: %w", err)
	}
	next := end - int64(n)
	alloc := func() int64 { next++; return next }

	type lost struct {
		sql  string
		args []any
	}
	var losers []lost

	b := &pgx.Batch{}
	type pending struct {
		key  string
		rev  int64
		bump lost // sql 为空表示这一行不会「输」（workouts 是按字段合并，永远生效）
	}
	var order []pending

	for _, r := range sets {
		rev := alloc()
		b.Queue(upsertSetSQL, uid, r.Date, r.ExID, r.SetNo, r.ExCn, r.Part, r.PlanKey, r.Sig,
			r.Weight, r.Reps, r.Unit, r.Done, r.at, rev,
			r.Slot, r.Rir, r.Assist, r.TargetWeight, r.TargetReps, r.TargetSets, r.CompletedAt, r.Warmup,
			r.BlockID, r.TrackVer)
		order = append(order, pending{r.key(), rev, lost{bumpSetSQL, []any{uid, r.Date, r.ExID, r.SetNo, rev}}})
	}
	for _, r := range workouts {
		rev := alloc()
		b.Queue(upsertWorkoutSQL, uid, r.Date, r.PlanKey, r.PlanName, r.Sig, r.ProgramID,
			r.StartedAt, r.FinishedAt, r.Feel, r.Note, r.Done, r.at, rev)
		order = append(order, pending{r.key(), rev, lost{}})
	}
	for _, r := range metrics {
		rev := alloc()
		b.Queue(upsertMetricSQL, uid, r.Kind, r.Date, r.Value, r.Unit, r.Note, r.Done, r.at, rev)
		order = append(order, pending{r.key(), rev, lost{bumpMetricSQL, []any{uid, r.Kind, r.Date, rev}}})
	}
	for _, r := range exercises {
		rev := alloc()
		b.Queue(upsertCustomExerciseSQL, uid, r.ExID, r.Cn, r.Part, r.Place, r.Unit, r.Tips, r.Done, r.at, rev)
		order = append(order, pending{r.key(), rev, lost{bumpCustomExerciseSQL, []any{uid, r.ExID, rev}}})
	}
	if cfg != nil {
		rev := alloc()
		b.Queue(upsertConfigSQL, uid, string(cfg.Body), cfg.at, rev)
		order = append(order, pending{"config", rev, lost{bumpConfigSQL, []any{uid, rev}}})
	}

	br := tx.SendBatch(ctx, b)
	for _, p := range order {
		ct, err := br.Exec()
		if err != nil {
			br.Close()
			return res, fmt.Errorf("写入 %s: %w", p.key, err)
		}
		if ct.RowsAffected() > 0 {
			res.applied++
			res.won[p.key] = p.rev
		} else if p.bump.sql != "" {
			losers = append(losers, p.bump)
		}
	}
	if err := br.Close(); err != nil {
		return res, err
	}

	if len(losers) > 0 {
		b2 := &pgx.Batch{}
		for _, l := range losers {
			b2.Queue(l.sql, l.args...)
		}
		if err := tx.SendBatch(ctx, b2).Close(); err != nil {
			return res, fmt.Errorf("刷新落败行版本号: %w", err)
		}
	}

	if err := s.refreshWorkoutDone(ctx, tx, uid, sets, workouts); err != nil {
		return res, err
	}

	return res, tx.Commit(ctx)
}

// refreshWorkoutDone：以 sets 为准重新计算受影响日期的 workouts.done。
//
// 这样「当天的组全部取消 → 这次训练消失」「再完成一组 → 训练恢复」
// 都由服务端保证，和上传顺序无关（模块设计 §6.2 / §7.3）。
// done 真的发生变化的行要分配新 rev，其他设备才能拉到。
func (s *store) refreshWorkoutDone(ctx context.Context, tx pgx.Tx, uid int64,
	sets []setIn, workouts []workoutIn) error {

	affected := map[string]bool{}
	for _, r := range sets {
		affected[r.Date] = true
	}
	for _, r := range workouts {
		affected[r.Date] = true
	}
	if len(affected) == 0 {
		return nil
	}

	dates := make([]string, 0, len(affected))
	for d := range affected {
		dates = append(dates, d)
	}

	rows, err := tx.Query(ctx, workoutDoneDiffSQL, uid, dates)
	if err != nil {
		return fmt.Errorf("检查训练完成状态: %w", err)
	}
	var flip []string
	for rows.Next() {
		var (
			d      string
			done   bool
			should bool
		)
		if err := rows.Scan(&d, &done, &should); err != nil {
			rows.Close()
			return err
		}
		if done != should {
			flip = append(flip, d)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(flip) == 0 {
		return nil
	}

	var end int64
	if err := tx.QueryRow(ctx,
		`update users set rev = rev + $2 where id = $1 returning rev`, uid, len(flip)).Scan(&end); err != nil {
		return fmt.Errorf("为训练状态分配版本号: %w", err)
	}
	next := end - int64(len(flip))
	for _, d := range flip {
		next++
		if _, err := tx.Exec(ctx, workoutDoneSetSQL, uid, d, next); err != nil {
			return fmt.Errorf("刷新训练完成状态: %w", err)
		}
	}
	return nil
}

var errUserGone = errors.New("用户不存在")

/* ---------------- 拉：按 rev 取增量 ---------------- */

type pullResult struct {
	sets            []SetRow
	workouts        []WorkoutRow
	metrics         []MetricRow
	customExercises []CustomExerciseRow
	config          *ConfigDoc
	catalogRev      int64 // 官方动作清单的整份版本号，随每次 /sync 下发
	cursor          int64
	hasMore         bool
}

const setColumns = `date::text, ex_id, set_no, ex_cn, part, plan_key, sig,
                    weight::float8, reps, unit, done, updated_at, rev,
                    slot, rir, assist::float8, target_weight::float8,
                    target_reps, target_sets, completed_at, warmup, block_id, track_ver`

const workoutColumns = `date::text, plan_key, plan_name, sig, program_id,
                        started_at, finished_at, feel, note, done, updated_at, rev`

const metricColumns = `kind, date::text, value::float8, unit, note, done, updated_at, rev`

const customExerciseColumns = `ex_id, cn, part, place, unit, tips, done, updated_at, rev`

// pull 在一个可重复读的只读事务里取增量：users.rev 和各表的行来自同一个快照，
// 所以「这次已经看全了」的判断（cursor = users.rev）不会和并发写入打架。
func (s *store) pull(ctx context.Context, uid int64, cursor int64, limit int) (pullResult, error) {
	var out pullResult

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)

	var userRev int64
	if err := tx.QueryRow(ctx, `select rev from users where id = $1`, uid).Scan(&userRev); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return out, errUserGone
		}
		return out, err
	}

	// 游标比服务端还大：服务端数据被重置过（或客户端存坏了）。从头拉，宁多勿漏。
	if cursor > userRev || cursor < 0 {
		cursor = 0
	}

	rows, err := tx.Query(ctx, `select `+setColumns+` from sets
		where user_id = $1 and rev > $2 order by rev limit $3`, uid, cursor, limit)
	if err != nil {
		return out, err
	}
	sets, err := scanSets(rows)
	if err != nil {
		return out, err
	}

	rows, err = tx.Query(ctx, `select `+workoutColumns+` from workouts
		where user_id = $1 and rev > $2 order by rev limit $3`, uid, cursor, limit)
	if err != nil {
		return out, err
	}
	workouts, err := scanWorkouts(rows)
	if err != nil {
		return out, err
	}

	rows, err = tx.Query(ctx, `select `+metricColumns+` from metrics
		where user_id = $1 and rev > $2 order by rev limit $3`, uid, cursor, limit)
	if err != nil {
		return out, err
	}
	metrics, err := scanMetrics(rows)
	if err != nil {
		return out, err
	}

	rows, err = tx.Query(ctx, `select `+customExerciseColumns+` from user_exercises
		where user_id = $1 and rev > $2 order by rev limit $3`, uid, cursor, limit)
	if err != nil {
		return out, err
	}
	exercises, err := scanCustomExercises(rows)
	if err != nil {
		return out, err
	}

	var (
		body []byte
		ts   time.Time
		crev int64
	)
	err = tx.QueryRow(ctx, `select body::text, updated_at, rev from user_config
		where user_id = $1 and rev > $2`, uid, cursor).Scan(&body, &ts, &crev)
	switch {
	case err == nil:
		out.config = &ConfigDoc{Body: body, UpdatedAt: rfc3339(ts), rev: crev}
	case errors.Is(err, pgx.ErrNoRows):
	default:
		return out, err
	}

	page, cur, more := pagePull(sets, workouts, metrics, exercises, limit, userRev)
	out.sets, out.workouts, out.metrics, out.customExercises = page.sets, page.workouts, page.metrics, page.customExercises
	out.cursor, out.hasMore = cur, more

	// 官方动作清单的版本号：搭在 /sync 上一次下发，客户端比自己的大就去拉 /api/catalog。
	// 空库时 catalog_meta 里也有一行（rev=1），所以这里基本不会 ErrNoRows。
	if err := tx.QueryRow(ctx, `select rev from catalog_meta where id = 1`).Scan(&out.catalogRev); err != nil &&
		!errors.Is(err, pgx.ErrNoRows) {
		return out, err
	}
	return out, nil
}

// pageKind 标明一行来自哪张表。
//
// 加新表（cardio / agendas）时只需要三处：
//  1. 这里加一个常量
//  2. pullPage 加一个切片字段
//  3. pagePull 里加一行 addRefs + 一个 case
//
// 排序、截断、游标推进这些容易写错的逻辑完全不用动。
type pageKind int

const (
	pageSet pageKind = iota
	pageWorkout
	pageMetric
	pageCustomExercise
)

// pageRef 是「某一类结果里的第 i 行」，带 rev 用于跨表统一排序。
type pageRef struct {
	rev  int64
	kind pageKind
	i    int
}

// pullPage 是一次拉取合成后的一页
type pullPage struct {
	sets            []SetRow
	workouts        []WorkoutRow
	metrics         []MetricRow
	customExercises []CustomExerciseRow
}

// addRefs 把一批行摊平成 pageRef
func addRefs[T revRow](refs []pageRef, kind pageKind, rows []T) []pageRef {
	for i := range rows {
		refs = append(refs, pageRef{rev: rows[i].revOf(), kind: kind, i: i})
	}
	return refs
}

// pagePull 把各表各自按 rev 取回的结果合成一页。
//
// 每张表都没取满 → 这个快照里的增量已经全部拿到，游标直接跳到 userRev（跳过空洞）；
// 否则按 rev 归并取前 limit 条，游标停在最后一条，hasMore=true。
// 被截掉的行 rev 都大于新游标，下一页一定能取到——不会漏。
func pagePull(sets []SetRow, workouts []WorkoutRow, metrics []MetricRow, exercises []CustomExerciseRow,
	limit int, userRev int64) (pullPage, int64, bool) {

	total := len(sets) + len(workouts) + len(metrics) + len(exercises)
	// 边界：一页就装得下，且每张表都没取满
	if len(sets) < limit && len(workouts) < limit && len(metrics) < limit && len(exercises) < limit &&
		total <= limit {
		return pullPage{sets: sets, workouts: workouts, metrics: metrics, customExercises: exercises},
			userRev, false
	}

	refs := make([]pageRef, 0, total)
	refs = addRefs(refs, pageSet, sets)
	refs = addRefs(refs, pageWorkout, workouts)
	refs = addRefs(refs, pageMetric, metrics)
	refs = addRefs(refs, pageCustomExercise, exercises)

	sort.Slice(refs, func(a, b int) bool { return refs[a].rev < refs[b].rev })
	if len(refs) > limit {
		refs = refs[:limit]
	}
	if len(refs) == 0 {
		return pullPage{}, userRev, false
	}

	out := pullPage{}
	for _, r := range refs {
		switch r.kind {
		case pageSet:
			out.sets = append(out.sets, sets[r.i])
		case pageWorkout:
			out.workouts = append(out.workouts, workouts[r.i])
		case pageMetric:
			out.metrics = append(out.metrics, metrics[r.i])
		case pageCustomExercise:
			out.customExercises = append(out.customExercises, exercises[r.i])
		}
	}
	return out, refs[len(refs)-1].rev, true
}

func scanSets(rows pgx.Rows) ([]SetRow, error) {
	defer rows.Close()
	out := []SetRow{}
	for rows.Next() {
		var (
			r  SetRow
			ts time.Time
			ca *time.Time
		)
		if err := rows.Scan(&r.Date, &r.ExID, &r.SetNo, &r.ExCn, &r.Part, &r.PlanKey,
			&r.Sig, &r.Weight, &r.Reps, &r.Unit, &r.Done, &ts, &r.rev,
			&r.Slot, &r.Rir, &r.Assist, &r.TargetWeight, &r.TargetReps, &r.TargetSets, &ca, &r.Warmup,
			&r.BlockID, &r.TrackVer); err != nil {
			return nil, err
		}
		r.UpdatedAt = rfc3339(ts)
		if ca != nil {
			s := rfc3339(*ca)
			r.CompletedAt = &s
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func scanWorkouts(rows pgx.Rows) ([]WorkoutRow, error) {
	defer rows.Close()
	out := []WorkoutRow{}
	for rows.Next() {
		var (
			r  WorkoutRow
			sa time.Time
			fa *time.Time
			ts time.Time
		)
		if err := rows.Scan(&r.Date, &r.PlanKey, &r.PlanName, &r.Sig, &r.ProgramID,
			&sa, &fa, &r.Feel, &r.Note, &r.Done, &ts, &r.rev); err != nil {
			return nil, err
		}
		r.StartedAt = rfc3339(sa)
		r.UpdatedAt = rfc3339(ts)
		if fa != nil {
			s := rfc3339(*fa)
			r.FinishedAt = &s
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func scanMetrics(rows pgx.Rows) ([]MetricRow, error) {
	defer rows.Close()
	out := []MetricRow{}
	for rows.Next() {
		var (
			r  MetricRow
			ts time.Time
		)
		if err := rows.Scan(&r.Kind, &r.Date, &r.Value, &r.Unit, &r.Note, &r.Done, &ts, &r.rev); err != nil {
			return nil, err
		}
		r.UpdatedAt = rfc3339(ts)
		out = append(out, r)
	}
	return out, rows.Err()
}

func scanCustomExercises(rows pgx.Rows) ([]CustomExerciseRow, error) {
	defer rows.Close()
	out := []CustomExerciseRow{}
	for rows.Next() {
		var (
			r  CustomExerciseRow
			ts time.Time
		)
		if err := rows.Scan(&r.ExID, &r.Cn, &r.Part, &r.Place, &r.Unit, &r.Tips,
			&r.Done, &ts, &r.rev); err != nil {
			return nil, err
		}
		r.UpdatedAt = rfc3339(ts)
		out = append(out, r)
	}
	return out, rows.Err()
}

/* ---------------- 官方动作库（全局内容，不进同步） ---------------- */

var errExerciseNotFound = errors.New("动作不存在")

// catalogRevOf：整份版本号。空库时 catalog_meta 也有一行（migrate 里 insert），
// 但防御性地把「没这行」当 0——客户端 0 < rev 会去拉一次空清单，无害。
func (s *store) catalogRevOf(ctx context.Context) (int64, error) {
	var rev int64
	err := s.pool.QueryRow(ctx, `select rev from catalog_meta where id = 1`).Scan(&rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return rev, err
}

// catalogList：整份清单。retired=true 的行也照发，由客户端过滤——
// 整份替换才能覆盖本地旧的「未下架」状态。
// 顺序由服务端定（hot desc, id）：Postgres 不带 order by 时返回顺序未定义，
// 两次拉取间顺序跳变会让用户觉得动作位置自己变了。
func (s *store) catalogList(ctx context.Context) (catalogResponse, error) {
	out := catalogResponse{Exercises: []catalogExercise{}}
	rev, err := s.catalogRevOf(ctx)
	if err != nil {
		return out, err
	}
	out.Rev = rev

	rows, err := s.pool.Query(ctx, `select id, cn, en, part, place, unit, tips, hot, img_thumb, retired
		from exercises order by hot desc, id`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var e catalogExercise
		if err := rows.Scan(&e.ID, &e.Cn, &e.En, &e.Part, &e.Place, &e.Unit, &e.Tips,
			&e.Hot, &e.ImgThumb, &e.Retired); err != nil {
			return out, err
		}
		out.Exercises = append(out.Exercises, e)
	}
	return out, rows.Err()
}

// catalogDetail：详情页用。大图只在这个接口后面——匿名面拿不到高清插画。
func (s *store) catalogDetail(ctx context.Context, id string) (exerciseDetail, error) {
	out := exerciseDetail{ID: id, Steps: []string{}}
	var steps []byte
	err := s.pool.QueryRow(ctx, `select steps::text, img_detail from exercises where id = $1`, id).
		Scan(&steps, &out.ImgDetail)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, errExerciseNotFound
	}
	if err != nil {
		return out, err
	}
	if len(steps) > 0 {
		if err := json.Unmarshal(steps, &out.Steps); err != nil {
			return out, fmt.Errorf("解析 steps: %w", err)
		}
	}
	return out, nil
}

/* ---------------- 身体指标（图表按区间取） ---------------- */

func (s *store) metricsRange(ctx context.Context, uid int64, kind, from, to string) ([]MetricRow, error) {
	q := `select ` + metricColumns + `
	      from metrics where user_id = $1
	        and ($2::text is null or kind = $2)
	        and ($3::text is null or date >= $3::text::date)
	        and ($4::text is null or date <= $4::text::date)
	        and done
	      order by date, kind limit 5000`
	rows, err := s.pool.Query(ctx, q, uid, nullableStr(kind), nullableStr(from), nullableStr(to))
	if err != nil {
		return nil, err
	}
	return scanMetrics(rows)
}

// nullableStr：空串 → NULL，配合 SQL 里 `$n is null or ...` 的分支判断
func nullableStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

/* ---------------- 历史摘要（全量聚合，不落表） ---------------- */

// 客户端本地保存全量历史，这个接口不在关键路径上：
// 用于新设备还没拉完历史时先显示总览，以及排查数据。
func (s *store) historySummary(ctx context.Context, uid int64, loc *time.Location) (historySummary, error) {
	out := historySummary{
		Exercises: []exerciseSummary{},
		AsOf:      rfc3339(time.Now()),
	}

	const scalarQ = `
select count(distinct date),
       coalesce(round(sum(case when unit = 'kg' then weight * reps else 0 end) / 1000.0, 1), 0)::float8
from sets where user_id = $1 and done`
	if err := s.pool.QueryRow(ctx, scalarQ, uid).Scan(&out.TotalDays, &out.TotalTon); err != nil {
		return out, fmt.Errorf("累计统计: %w", err)
	}

	const bestQ = `
select date::text,
       coalesce(round(sum(case when unit = 'kg' then weight * reps else 0 end) / 1000.0, 1), 0)::float8
from sets where user_id = $1 and done
group by date
order by 2 desc, date desc
limit 1`
	if err := s.pool.QueryRow(ctx, bestQ, uid).Scan(&out.BestDate, &out.BestTon); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return out, fmt.Errorf("单日最高: %w", err)
	}

	dates, err := s.trainingDays(ctx, uid)
	if err != nil {
		return out, err
	}
	out.Streak = streakFrom(dates, time.Now().In(loc))

	const perExQ = `
select ex_id,
       coalesce(max(weight) filter (where unit = 'kg' and weight > 0), 0)::float8 as pb,
       coalesce((max(date) filter (where unit = 'kg' and weight > 0))::text, '') as pb_date,
       max(date)::text as last_date,
       count(distinct date) as done_days
from sets where user_id = $1 and done and warmup is not true   -- 热身组不算最好成绩 / 上一次
group by ex_id
order by ex_id`

	idx := map[string]int{}
	rows, err := s.pool.Query(ctx, perExQ, uid)
	if err != nil {
		return out, fmt.Errorf("每动作摘要: %w", err)
	}
	for rows.Next() {
		var e exerciseSummary
		if err := rows.Scan(&e.ExID, &e.PB, &e.PBDate, &e.LastDate, &e.DoneDays); err != nil {
			rows.Close()
			return out, err
		}
		idx[e.ExID] = len(out.Exercises)
		out.Exercises = append(out.Exercises, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	const lastQ = `
select s.ex_id, s.weight::float8, s.reps, s.set_no
from sets s
join (
  select ex_id, max(date) as d
  from sets where user_id = $1 and done and warmup is not true group by ex_id
) m on m.ex_id = s.ex_id and m.d = s.date
where s.user_id = $1 and s.done and s.warmup is not true
order by s.ex_id, s.set_no`

	rows2, err := s.pool.Query(ctx, lastQ, uid)
	if err != nil {
		return out, fmt.Errorf("最后一次明细: %w", err)
	}
	defer rows2.Close()

	for rows2.Next() {
		var (
			exID   string
			weight float64
			reps   int
			setNo  int
		)
		if err := rows2.Scan(&exID, &weight, &reps, &setNo); err != nil {
			return out, err
		}
		i, ok := idx[exID]
		if !ok {
			continue
		}
		if weight > out.Exercises[i].LastWeight {
			out.Exercises[i].LastWeight = weight
		}
		if setNo == 1 || out.Exercises[i].LastReps == 0 {
			out.Exercises[i].LastReps = reps
		}
		out.Exercises[i].LastSets++
	}

	return out, rows2.Err()
}

func (s *store) trainingDays(ctx context.Context, uid int64) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx,
		`select distinct date::text from sets where user_id = $1 and done`, uid)
	if err != nil {
		return nil, fmt.Errorf("训练日列表: %w", err)
	}
	defer rows.Close()

	out := map[string]bool{}
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out[d] = true
	}
	return out, rows.Err()
}

// streakFrom：从今天往前数连续天数；今天还没练不算断签，从昨天开始数。
func streakFrom(days map[string]bool, now time.Time) int {
	cursor := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if !days[cursor.Format("2006-01-02")] {
		cursor = cursor.AddDate(0, 0, -1)
	}
	n := 0
	for days[cursor.Format("2006-01-02")] {
		n++
		cursor = cursor.AddDate(0, 0, -1)
	}
	return n
}
