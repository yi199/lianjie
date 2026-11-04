package main

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// 客户端时钟最多允许比服务器快这么多。
// 超出就按服务器时间记：否则一台时钟调到明年的手机，它写的每条记录都会永远赢下 LWW。
const maxClockSkew = 2 * time.Minute

const maxConfigBytes = 64 << 10 // 64KB：设置 + 换动作 + 几十个自定义方案绰绰有余

func itoa(n int) string { return strconv.Itoa(n) }

func validDate(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func shortText(s string, max int) bool {
	return utf8.RuneCountInString(s) <= max
}

// clientTime 解析客户端的 updatedAt，并把「比服务器还快」的时刻夹到服务器时间。
// 缺失或非法 → ok=false，这一行拒收（不能用 now() 顶替：那会让一条坏数据赢下 LWW）。
func clientTime(s string, now time.Time) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	t = t.UTC()
	if t.After(now.Add(maxClockSkew)) {
		t = now
	}
	return t, true
}

func validateSet(r *SetRow) string {
	switch {
	case !validDate(r.Date):
		return "date 必须是 YYYY-MM-DD"
	case r.ExID == "" || len(r.ExID) > 16:
		return "exId 为空或过长"
	case r.SetNo < 1 || r.SetNo > 50:
		return "setNo 必须在 1–50"
	case r.Unit != "kg" && r.Unit != "bw" && r.Unit != "sec":
		return "unit 只能是 kg / bw / sec"
	case r.Weight < 0 || r.Weight > 1000:
		return "weight 超出范围"
	case r.Reps < 0 || r.Reps > 36000:
		return "reps 超出范围"
	case !shortText(r.ExCn, 32) || !shortText(r.Part, 16) ||
		!shortText(r.PlanKey, 8) || !shortText(r.Sig, 128):
		return "文本字段过长"
	}

	// ---- 训练记录模块新增的可空字段：为空一律合法 ----
	if r.Slot != nil && (*r.Slot < 0 || *r.Slot > 19) {
		return "slot 必须在 0–19"
	}
	if r.Rir != nil && (*r.Rir < 0 || *r.Rir > 10) {
		return "rir 必须在 0–10"
	}
	if r.Assist != nil && (*r.Assist < 0 || *r.Assist > 1000) {
		return "assist 超出范围"
	}
	if r.TargetWeight != nil && (*r.TargetWeight < 0 || *r.TargetWeight > 1000) {
		return "targetWeight 超出范围"
	}
	if r.TargetReps != nil && (*r.TargetReps < 0 || *r.TargetReps > 36000) {
		return "targetReps 超出范围"
	}
	if r.TargetSets != nil && (*r.TargetSets < 1 || *r.TargetSets > 50) {
		return "targetSets 必须在 1–50"
	}
	if r.CompletedAt != nil && !validRFC3339(*r.CompletedAt) {
		return "completedAt 必须是 RFC3339"
	}

	// ---- 训练日程（训练记录 v0.3）----
	// blockId 是计划线 id（"t-..."）或 "adhoc:<id>"，32 字符足够；老客户端不传 = null
	if r.BlockID != nil && !shortText(*r.BlockID, 32) {
		return "blockId 过长"
	}
	if r.TrackVer != nil && *r.TrackVer < 0 {
		return "trackVer 不能为负"
	}
	return ""
}

// validateWorkout：一次训练。startedAt 必填，finishedAt 可空但不能早于 startedAt。
func validateWorkout(r *WorkoutRow) string {
	switch {
	case !validDate(r.Date):
		return "date 必须是 YYYY-MM-DD"
	case !shortText(r.PlanKey, 8):
		return "planKey 过长"
	case !shortText(r.PlanName, 32):
		return "planName 过长"
	case !shortText(r.Sig, 128):
		return "sig 过长"
	case !shortText(r.ProgramID, 64):
		return "programId 过长"
	case r.StartedAt == "":
		return "startedAt 必填"
	case !validRFC3339(r.StartedAt):
		return "startedAt 必须是 RFC3339"
	case r.FinishedAt != nil && !validRFC3339(*r.FinishedAt):
		return "finishedAt 必须是 RFC3339"
	case r.Feel != nil && (*r.Feel < 1 || *r.Feel > 5):
		return "feel 必须在 1–5"
	case !shortText(r.Note, 200):
		return "note 过长"
	}

	if r.FinishedAt != nil {
		start, err1 := time.Parse(time.RFC3339Nano, r.StartedAt)
		fin, err2 := time.Parse(time.RFC3339Nano, *r.FinishedAt)
		if err1 == nil && err2 == nil && fin.Before(start) {
			return "finishedAt 不能早于 startedAt"
		}
	}
	return ""
}

func validRFC3339(s string) bool {
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

func validateMetric(r *MetricRow) string {
	switch {
	case !validDate(r.Date):
		return "date 必须是 YYYY-MM-DD"
	case r.Kind == "" || len(r.Kind) > 16:
		return "kind 为空或过长"
	case r.Value < -100000 || r.Value > 100000:
		return "value 超出范围"
	case !shortText(r.Unit, 8) || !shortText(r.Note, 200):
		return "文本字段过长"
	}
	return ""
}

// ============ 自建动作（动作库模块） ============

// validCustomID：自建动作的 id 空间必须和官方（g*/h*）结构上不相交，
// 所以强制 "u-" 前缀；总长 ≤16 字节——ex_id 是 sets 主键的一部分，
// 超长会让「用这个动作记的每一组」被拒收，再按 rejected 出队 = 数据静默丢失。
func validCustomID(s string) bool {
	if len(s) < 3 || len(s) > 16 || s[:2] != "u-" {
		return false
	}
	body := s[2:]
	if body[len(body)-1] == '-' {
		return false
	}
	for i := 0; i < len(body); i++ {
		c := body[i]
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

func validPart(s string) bool {
	switch s {
	case "chest", "shoulders", "arms", "back", "legs", "core":
		return true
	}
	return false
}

// validateCustomExercise：自建动作。枚举字段服务端是唯一真相——
// 客户端对未知值要降级（unit 归一成 kg）再上传，不能赌服务端宽容。
func validateCustomExercise(r *CustomExerciseRow) string {
	switch {
	case !validCustomID(r.ExID):
		return "exId 必须以 u- 开头、总长 ≤16、只含小写字母数字和连字符"
	case len(strings.TrimSpace(r.Cn)) == 0:
		return "cn 必填"
	case !shortText(r.Cn, 24):
		return "cn ≤24 字"
	case !validPart(r.Part):
		return "part 必须是 chest/shoulders/arms/back/legs/core"
	case r.Place != "gym" && r.Place != "home":
		return "place 只能是 gym / home"
	case r.Unit != "kg" && r.Unit != "bw" && r.Unit != "sec":
		return "unit 只能是 kg / bw / sec"
	case !shortText(r.Tips, 64):
		return "tips ≤64 字"
	}
	return ""
}

func validateConfig(c *ConfigDoc) string {
	b := bytes.TrimSpace(c.Body)
	if len(b) == 0 || b[0] != '{' || !json.Valid(b) {
		return "body 必须是 JSON 对象"
	}
	if len(b) > maxConfigBytes {
		return "body 超过 64KB"
	}
	return ""
}
