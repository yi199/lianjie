package main

import (
	"context"
	_ "embed"
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

type workoutIn struct {
	WorkoutRow
	at       time.Time
	started  time.Time
	finished *time.Time
}

type metricIn struct {
	MetricRow
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
                  slot, rir, assist, target_weight, target_reps, target_sets, completed_at)
values ($1, $2::text::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20, $21::text::timestamptz)
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

// push 在一个事务里写入一批变更。
//
// 并发模型：先 `update users set rev = rev + n` —— 这一句同时做两件事：
//  1. 一次性为这批行分配 n 个连续版本号；
//  2. 锁住该用户那一行直到提交。同一用户的并发写因此串行，
//     保证「rev 小的一定先提交」，拉增量的游标才不会跳过还没提交的行。
//
// 不同用户之间互不阻塞。
func (s *store) push(ctx context.Context, uid int64, sets []setIn, workouts []workoutIn, metrics []metricIn, cfg *configIn) (pushResult, error) {
	res := pushResult{won: map[string]int64{}}
	n := len(sets) + len(workouts) + len(metrics)
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
			r.Slot, r.Rir, r.Assist, r.TargetWeight, r.TargetReps, r.TargetSets, r.CompletedAt)
		order = append(order, pending{r.key(), rev, lost{bumpSetSQL, []any{uid, r.Date, r.ExID, r.SetNo, rev}}})
	}
	for _, r := range workouts {
		rev := alloc()
		b.Queue(upsertWorkoutSQL, uid, r.Date, r.PlanKey, r.PlanName, r.Sig, r.ProgramID,
			r.started, r.finished, r.Feel, r.Note, r.Done, r.at, rev)
		order = append(order, pending{r.key(), rev, lost{}})
	}
	for _, r := range metrics {
		rev := alloc()
		b.Queue(upsertMetricSQL, uid, r.Kind, r.Date, r.Value, r.Unit, r.Note, r.Done, r.at, rev)
		order = append(order, pending{r.key(), rev, lost{bumpMetricSQL, []any{uid, r.Kind, r.Date, rev}}})
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
	sets     []SetRow
	workouts []WorkoutRow
	metrics  []MetricRow
	config   *ConfigDoc
	cursor   int64
	hasMore  bool
}

const setColumns = `date::text, ex_id, set_no, ex_cn, part, plan_key, sig,
                    weight::float8, reps, unit, done, updated_at, rev,
                    slot, rir, assist::float8, target_weight::float8,
                    target_reps, target_sets, completed_at`

const workoutColumns = `date::text, plan_key, plan_name, sig, program_id,
                        started_at, finished_at, feel, note, done, updated_at, rev`

const metricColumns = `kind, date::text, value::float8, unit, note, done, updated_at, rev`

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

	out.sets, out.workouts, out.metrics, out.cursor, out.hasMore =
		pagePull(sets, workouts, metrics, limit, userRev)
	return out, nil
}

// pagePull 把三张表各自按 rev 取回的结果合成一页。
//
// 三边都没取满 → 这个快照里的增量已经全部拿到，游标直接跳到 userRev（跳过空洞）；
// 否则按 rev 归并取前 limit 条，游标停在最后一条，hasMore=true。
// 被截掉的行 rev 都大于新游标，下一页一定能取到——不会漏。
func pagePull(sets []SetRow, workouts []WorkoutRow, metrics []MetricRow,
	limit int, userRev int64) ([]SetRow, []WorkoutRow, []MetricRow, int64, bool) {

	total := len(sets) + len(workouts) + len(metrics)
	if len(sets) < limit && len(workouts) < limit && len(metrics) < limit && total <= limit {
		return sets, workouts, metrics, userRev, false
	}

	const (
		kindSet = iota
		kindWorkout
		kindMetric
	)
	type ref struct {
		rev  int64
		kind int
		i    int
	}
	refs := make([]ref, 0, total)
	for i, r := range sets {
		refs = append(refs, ref{r.rev, kindSet, i})
	}
	for i, r := range workouts {
		refs = append(refs, ref{r.rev, kindWorkout, i})
	}
	for i, r := range metrics {
		refs = append(refs, ref{r.rev, kindMetric, i})
	}
	sort.Slice(refs, func(a, b int) bool { return refs[a].rev < refs[b].rev })
	if len(refs) > limit {
		refs = refs[:limit]
	}

	outS := []SetRow{}
	outW := []WorkoutRow{}
	outM := []MetricRow{}
	for _, r := range refs {
		switch r.kind {
		case kindSet:
			outS = append(outS, sets[r.i])
		case kindWorkout:
			outW = append(outW, workouts[r.i])
		default:
			outM = append(outM, metrics[r.i])
		}
	}
	return outS, outW, outM, refs[len(refs)-1].rev, true
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
			&r.Slot, &r.Rir, &r.Assist, &r.TargetWeight, &r.TargetReps, &r.TargetSets, &ca); err != nil {
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
from sets where user_id = $1 and done
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
  from sets where user_id = $1 and done group by ex_id
) m on m.ex_id = s.ex_id and m.d = s.date
where s.user_id = $1 and s.done
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
