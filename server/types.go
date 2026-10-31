package main

import "encoding/json"

// ============ 通用 ============

type apiErr struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errBody struct {
	Error apiErr `json:"error"`
}

// ============ 登录 ============

type loginRequest struct {
	Code string `json:"code"`
}

type loginResponse struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt"`
}

// ============ 组记录 ============

type SetRow struct {
	Date      string  `json:"date"` // YYYY-MM-DD
	ExID      string  `json:"exId"`
	SetNo     int     `json:"setNo"`
	ExCn      string  `json:"exCn"`
	Part      string  `json:"part"`
	PlanKey   string  `json:"planKey"`
	Sig       string  `json:"sig"`
	Weight    float64 `json:"weight"`
	Reps      int     `json:"reps"`
	Unit      string  `json:"unit"` // kg | bw | sec
	Done      bool    `json:"done"` // false = 墓碑
	UpdatedAt string  `json:"updatedAt"`

	rev int64 // 服务端版本号，只在服务端内部用（拉增量排序、分页）
}

func (r SetRow) key() string {
	return "s|" + r.Date + "|" + r.ExID + "|" + itoa(r.SetNo)
}

// ============ 身体指标 ============

type MetricRow struct {
	Kind      string  `json:"kind"`
	Date      string  `json:"date"`
	Value     float64 `json:"value"`
	Unit      string  `json:"unit"`
	Note      string  `json:"note"`
	Done      bool    `json:"done"`
	UpdatedAt string  `json:"updatedAt"`

	rev int64
}

func (r MetricRow) key() string {
	return "m|" + r.Kind + "|" + r.Date
}

// ============ 配置文档 ============

// ConfigDoc：设置 + 换动作 + 自定义方案打包成一份，整份 LWW。
// 这三样会联动（启用方案会同时改设置、清换动作），拆开同步会出现组合不一致。
// body 的结构由客户端定义，服务端只校验「是 JSON 对象、不超过上限」，原样存取。
type ConfigDoc struct {
	Body      json.RawMessage `json:"body"`
	UpdatedAt string          `json:"updatedAt"`

	rev int64
}

// ============ 同步 ============

type syncRequest struct {
	Cursor  int64       `json:"cursor"` // 上次拿到的 cursor；首次传 0
	Sets    []SetRow    `json:"sets"`
	Metrics []MetricRow `json:"metrics"`
	Config  *ConfigDoc  `json:"config"` // 本地配置没改过就传 null
}

// rejectedRow：校验不过的行。客户端收到后应把它移出待上传队列，
// 否则一条坏数据会让队列永远卡住（每次重试都 400）。
type rejectedRow struct {
	Kind   string `json:"kind"` // set | metric | config
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

type syncResponse struct {
	Cursor     int64         `json:"cursor"`
	HasMore    bool          `json:"hasMore"`
	Applied    int           `json:"applied"`
	Rejected   []rejectedRow `json:"rejected"`
	Sets       []SetRow      `json:"sets"`
	Metrics    []MetricRow   `json:"metrics"`
	Config     *ConfigDoc    `json:"config"`
	ServerTime string        `json:"serverTime"`
}

// ============ 历史摘要 ============

type exerciseSummary struct {
	ExID       string  `json:"exId"`
	PB         float64 `json:"pb"`
	PBDate     string  `json:"pbDate"`
	LastDate   string  `json:"lastDate"`
	LastWeight float64 `json:"lastWeight"`
	LastSets   int     `json:"lastSets"`
	LastReps   int     `json:"lastReps"`
	DoneDays   int     `json:"doneDays"`
}

type historySummary struct {
	TotalTon  float64           `json:"totalTon"`
	TotalDays int               `json:"totalDays"`
	BestTon   float64           `json:"bestTon"`
	BestDate  string            `json:"bestDate"`
	Streak    int               `json:"streak"`
	Exercises []exerciseSummary `json:"exercises"`
	AsOf      string            `json:"asOf"`
}
