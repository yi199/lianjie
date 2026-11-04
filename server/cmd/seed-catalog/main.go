// seed-catalog：把官方动作清单导进数据库。
//
// 用法（在 server/ 下）：
//
//	DATABASE_URL=... go run ./cmd/seed-catalog -file content/exercises.json
//
// 幂等：按 id upsert，同一条内容重复导入不会产生重复行；每次导入都把
// catalog_meta.rev + 1（同一事务），客户端据此知道「整份变了」。
//
// 内容质量自己校验：只靠客户端/同步链路的 validateCustomExercise 的话，
// 官方内容写错了只能手工改 SQL。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type catalogRow struct {
	ID        string   `json:"id"`
	Cn        string   `json:"cn"`
	En        string   `json:"en"`
	Part      string   `json:"part"`
	Place     string   `json:"place"`
	Unit      string   `json:"unit"`
	Tips      string   `json:"tips"`
	Hot       bool     `json:"hot"`
	Steps     []string `json:"steps"`
	ImgThumb  string   `json:"imgThumb"`
	ImgDetail string   `json:"imgDetail"`
	Retired   bool     `json:"retired"`
}

func main() {
	file := flag.String("file", "content/exercises.json", "动作清单 JSON 路径")
	dryRun := flag.Bool("dry-run", false, "只校验不写库")
	flag.Parse()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" && !*dryRun {
		log.Fatal("缺少 DATABASE_URL")
	}

	rows, err := load(*file)
	if err != nil {
		log.Fatalf("%v", err)
	}
	log.Printf("校验通过：%d 条（hot %d 条）", len(rows), countHot(rows))
	if *dryRun {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("连库: %v", err)
	}
	defer pool.Close()

	// 表由服务启动时建（schema.sql 用 go:embed，只在服务里）。这里先探一下，
	// 给出能直接照做的提示，而不是让用户看一个 "relation does not exist"。
	if _, err := pool.Exec(ctx, `select 1 from exercises limit 1`); err != nil {
		log.Fatalf("exercises 表不存在：先启动一次服务（它会自动建表）再跑这个命令。\n  原始错误: %v", err)
	}

	rev, imported, err := seed(ctx, pool, rows)
	if err != nil {
		log.Fatalf("导入: %v", err)
	}

	var total int
	if err := pool.QueryRow(ctx, `select count(*) from exercises`).Scan(&total); err != nil {
		log.Printf("（库内总条数读取失败: %v）", err)
	}
	log.Printf("导入完成：本批 %d 条，catalog_meta.rev = %d，库内共 %d 条", imported, rev, total)
}

func countHot(rows []catalogRow) int {
	n := 0
	for _, r := range rows {
		if r.Hot {
			n++
		}
	}
	return n
}

func load(path string) ([]catalogRow, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读清单: %w", err)
	}
	var rows []catalogRow
	if err := json.Unmarshal(b, &rows); err != nil {
		return nil, fmt.Errorf("解析 JSON: %w", err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("清单是空的：%s", path)
	}

	seen := map[string]bool{}
	var problems []string
	for i := range rows {
		r := &rows[i]
		where := fmt.Sprintf("第 %d 条(%s)", i+1, r.ID)
		if why := validate(r); why != "" {
			problems = append(problems, where+"："+why)
			continue
		}
		if seen[r.ID] {
			problems = append(problems, where+"：id 重复")
		}
		seen[r.ID] = true
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("清单有 %d 处问题：\n  %s", len(problems), strings.Join(problems, "\n  "))
	}
	return rows, nil
}

// validate：内容侧的校验。规则同 docs/设计文档/动作库.md §2.3。
func validate(r *catalogRow) string {
	switch {
	case r.ID == "" || len(r.ID) > 16:
		return "id 为空或超过 16 字节"
	case !isOfficialID(r.ID):
		return "官方 id 必须是 g/h 开头加字母数字（自建动作是 u- 开头，不能混）"
	case strings.TrimSpace(r.Cn) == "":
		return "cn 必填"
	case utf8.RuneCountInString(r.Cn) > 24:
		return "cn 超过 24 字"
	}
	switch r.Part {
	case "chest", "shoulders", "arms", "back", "legs", "core":
	default:
		return "part 非法: " + r.Part
	}
	switch r.Place {
	case "gym", "home":
	default:
		return "place 非法: " + r.Place
	}
	switch r.Unit {
	case "kg", "bw", "sec":
	default:
		return "unit 非法: " + r.Unit
	}
	if utf8.RuneCountInString(r.Tips) > 64 {
		return "tips 超过 64 字"
	}
	if utf8.RuneCountInString(r.En) > 48 {
		return "en 超过 48 字"
	}
	if len(r.Steps) > 10 {
		return "steps 超过 10 步"
	}
	for i, s := range r.Steps {
		if utf8.RuneCountInString(s) > 200 {
			return fmt.Sprintf("steps 第 %d 步超过 200 字", i+1)
		}
	}
	for _, u := range []struct {
		name, url string
	}{{"imgThumb", r.ImgThumb}, {"imgDetail", r.ImgDetail}} {
		if u.url == "" {
			continue
		}
		if !strings.HasPrefix(u.url, "https://") || len(u.url) > 300 {
			return u.name + " 必须是 https:// 开头且 ≤300 字节"
		}
	}
	return ""
}

// isOfficialID：官方 id 是 g1 / h12 这种（首字母 + 数字），不含连字符。
// 和自建动作的 u- 前缀结构上分开，谁也不会覆盖谁。
func isOfficialID(s string) bool {
	if len(s) < 2 || len(s) > 16 {
		return false
	}
	if s[0] != 'g' && s[0] != 'h' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if c := s[i]; !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

const upsertSQL = `
insert into exercises (id, cn, en, part, place, unit, tips, hot, steps, img_thumb, img_detail, retired, updated_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11, $12, now())
on conflict (id) do update set
  cn         = excluded.cn,
  en         = excluded.en,
  part       = excluded.part,
  place      = excluded.place,
  unit       = excluded.unit,
  tips       = excluded.tips,
  hot        = excluded.hot,
  steps      = excluded.steps,
  img_thumb  = excluded.img_thumb,
  img_detail = excluded.img_detail,
  retired    = excluded.retired,
  updated_at = now()`

// seed：整批在一个事务里 upsert，末尾 rev + 1。
// 中途失败全部回滚——不会出现「导了一半、rev 却前进了」的半成品清单。
func seed(ctx context.Context, pool *pgxpool.Pool, rows []catalogRow) (int64, int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)

	b := &pgx.Batch{}
	for _, r := range rows {
		steps, err := json.Marshal(r.Steps)
		if err != nil {
			return 0, 0, fmt.Errorf("编码 steps(%s): %w", r.ID, err)
		}
		if r.Steps == nil {
			steps = []byte("[]")
		}
		b.Queue(upsertSQL, r.ID, r.Cn, r.En, r.Part, r.Place, r.Unit, r.Tips, r.Hot,
			string(steps), r.ImgThumb, r.ImgDetail, r.Retired)
	}
	br := tx.SendBatch(ctx, b)
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			br.Close()
			return 0, 0, fmt.Errorf("写入第 %d 条: %w", n+1, err)
		}
		n++
	}
	if err := br.Close(); err != nil {
		return 0, 0, err
	}

	var rev int64
	if err := tx.QueryRow(ctx,
		`update catalog_meta set rev = rev + 1, updated_at = now() where id = 1 returning rev`).Scan(&rev); err != nil {
		return 0, 0, fmt.Errorf("推进 catalog_meta.rev: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return rev, n, nil
}
