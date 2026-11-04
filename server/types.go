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

	// ---- 训练记录模块新增（均可为 null）----
	// 服务端对这批可空字段用 coalesce 合并：旧版客户端传 null 不会清空已有值。
	Slot         *int     `json:"slot"`         // 动作位置，0 起；自由加练为空
	Rir          *int     `json:"rir"`          // 还剩几次力气
	Assist       *float64 `json:"assist"`       // 助力重量
	TargetWeight *float64 `json:"targetWeight"` // 当时的建议重量
	TargetReps   *int     `json:"targetReps"`   // 当时的计划次数
	TargetSets   *int     `json:"targetSets"`   // 当时的计划组数
	CompletedAt  *string  `json:"completedAt"`  // 这组完成的时刻（RFC3339）
	Warmup       *bool    `json:"warmup"`       // 热身组；null 视为正式组

	// ---- 训练日程（训练记录 v0.3）----
	// 同一天可能有多条计划线含同一动作，靠 blockId 分清哪几组算哪条线。
	BlockID  *string `json:"blockId"`  // 计划线 id；临时自由训练 = "adhoc:<id>"；空视为 "main"
	TrackVer *int    `json:"trackVer"` // 记录时计划线的版本号：判断「换了结构之后旧记录不参与轮转」

	rev int64 // 服务端版本号，只在服务端内部用（拉增量排序、分页）
}

// revRow 让各表的行能被 pagePull 统一摊平成「rev + 类型 + 下标」，
// 加新表时只要实现这个方法，排序与切页逻辑一行都不用改。
type revRow interface{ revOf() int64 }

func (r SetRow) revOf() int64            { return r.rev }
func (r WorkoutRow) revOf() int64        { return r.rev }
func (r MetricRow) revOf() int64         { return r.rev }
func (r CustomExerciseRow) revOf() int64 { return r.rev }

func (r SetRow) key() string {
	return "s|" + r.Date + "|" + r.ExID + "|" + itoa(r.SetNo)
}

// ============ 一次训练 ============

// WorkoutRow：一天一行。done 不按上传值——服务端按「这一天是否还有 done=true 的组」算。
type WorkoutRow struct {
	Date       string  `json:"date"` // 训练归属的日期（跨零点算开始的那天）
	PlanKey    string  `json:"planKey"`
	PlanName   string  `json:"planName"`
	Sig        string  `json:"sig"`
	ProgramID  string  `json:"programId"`
	StartedAt  string  `json:"startedAt"`  // 必填
	FinishedAt *string `json:"finishedAt"` // 空 = 还没点「完成训练」
	Feel       *int    `json:"feel"`
	Note       string  `json:"note"`
	Done       bool    `json:"done"`
	UpdatedAt  string  `json:"updatedAt"`

	rev int64
}

func (r WorkoutRow) key() string { return "w|" + r.Date }

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

// ============ 自建动作（动作库模块） ============

// CustomExerciseRow：用户自己建的动作。和 sets 同一套机制（自然主键 + rev + LWW + 墓碑）。
// exId 必须带 "u-" 前缀：官方 id 空间是 g*/h*，自建是 u-*，结构上不相交，
// 所以两台设备离线各建一个动作也不需要对号段、不需要查重。
type CustomExerciseRow struct {
	ExID      string `json:"exId"`
	Cn        string `json:"cn"`
	Part      string `json:"part"`  // chest|shoulders|arms|back|legs|core
	Place     string `json:"place"` // gym|home
	Unit      string `json:"unit"`  // kg|bw|sec
	Tips      string `json:"tips"`
	Done      bool   `json:"done"` // false = 墓碑
	UpdatedAt string `json:"updatedAt"`

	rev int64
}

func (r CustomExerciseRow) key() string { return "x|" + r.ExID }

// ============ 官方动作库（只读下发，不进同步） ============

// catalogExercise：清单里的一条。列表接口只给缩略图，详细插画在详情接口后面。
type catalogExercise struct {
	ID       string `json:"id"`
	Cn       string `json:"cn"`
	En       string `json:"en"`
	Part     string `json:"part"`
	Place    string `json:"place"`
	Unit     string `json:"unit"`
	Tips     string `json:"tips"`
	Hot      bool   `json:"hot"`
	ImgThumb string `json:"imgThumb"`
	Retired  bool   `json:"retired"` // 由客户端过滤；整份下发才能覆盖本地旧的「未下架」
}

// catalogResponse：永远是整份清单。客户端只有一条写入路径（整份替换），
// 不需要处理增量合并，所以 since 只决定「要不要给」，不决定「给多少」。
type catalogResponse struct {
	Rev       int64             `json:"rev"`
	Exercises []catalogExercise `json:"exercises"`
}

// exerciseDetail：详情页用，要登录才给大图。
type exerciseDetail struct {
	ID        string   `json:"id"`
	Steps     []string `json:"steps"`
	ImgDetail string   `json:"imgDetail"`
}

// ============ 同步 ============

type syncRequest struct {
	Cursor          int64               `json:"cursor"` // 上次拿到的 cursor；首次传 0
	Sets            []SetRow            `json:"sets"`
	Workouts        []WorkoutRow        `json:"workouts"`
	Metrics         []MetricRow         `json:"metrics"`
	CustomExercises []CustomExerciseRow `json:"customExercises"` // 动作库：第 4 类资源
	Config          *ConfigDoc          `json:"config"`          // 本地配置没改过就传 null
}

// rejectedRow：校验不过的行。客户端收到后应把它移出待上传队列，
// 否则一条坏数据会让队列永远卡住（每次重试都 400）。
type rejectedRow struct {
	Kind   string `json:"kind"` // set | workout | metric | customExercise | config
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

type syncResponse struct {
	Cursor          int64               `json:"cursor"`
	HasMore         bool                `json:"hasMore"`
	Applied         int                 `json:"applied"`
	Rejected        []rejectedRow       `json:"rejected"`
	Sets            []SetRow            `json:"sets"`
	Workouts        []WorkoutRow        `json:"workouts"`
	Metrics         []MetricRow         `json:"metrics"`
	CustomExercises []CustomExerciseRow `json:"customExercises"`
	Config          *ConfigDoc          `json:"config"`
	// catalogRev：官方动作清单的整份版本号。客户端比自己的大就去拉 /api/catalog。
	// 搭在 /sync 上而不是独立心跳：/sync 的触发点（onShow、改动后防抖、失败重试）都是现成的。
	CatalogRev int64  `json:"catalogRev"`
	ServerTime string `json:"serverTime"`
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
