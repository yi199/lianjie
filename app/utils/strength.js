/**
 * 力量水平（设计文档 §8 · V3）
 *
 * 回答一个「进步」之外的问题：**我在同类人里算什么水平**。
 * 公式只有一句：估算 1RM ÷ 体重 → 查标准表 → 五档里落在哪一档。
 *
 * 三个刻意的选择：
 *   1. 只对 5 个标准动作评级（卧推 / 深蹲 / 硬拉 / 推举 / 引体）。哑铃、器械、
 *      绳索的重量口径和杠铃不是一回事，硬凑只会给出误导性的结论。
 *   2. 体重取「最近一次记录」；算过去某组的负荷时用 progress.bodyweightAt 取
 *      那天之前的体重，不用今天的体重改写历史。
 *   3. 没填性别或没有体重 → 直接告诉用户缺什么，绝不编一个默认值凑数。
 */

const M = require('../data/progress-model');
const STD = require('../data/strength-standard');
const P = require('./progress');
const db = require('./db');

/** 最近一次体重（没有就返回 0） */
function latestWeight() {
  const series = db.metricSeries('weight') || [];
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] && series[i].value > 0) return series[i].value;
  }
  return 0;
}

/** 年龄：只用来在标题里说清「按谁的标准」，评级本身不分年龄档 */
function ageOf(birthYear) {
  const y = Number(birthYear) || 0;
  if (!y) return 0;
  const now = new Date().getFullYear();
  const age = now - y;
  return age > 0 && age < 120 ? age : 0;
}

/**
 * 倍体重 → 段位。
 * @param ratio 估算 1RM ÷ 体重
 * @param th    [入门, 中级, 进阶, 精英] 四个门槛
 */
function levelFor(ratio, th) {
  const r = Number(ratio) || 0;
  let idx = 0;
  for (let i = 0; i < th.length; i++) {
    if (r >= th[i]) idx = i + 1;
  }
  return {
    idx: idx,
    name: STD.LEVELS[idx],
    next: idx < th.length ? th[idx] : null,        // 下一档的门槛
    toNext: idx < th.length ? Math.max(0, Math.round((th[idx] - r) * 100) / 100) : 0
  };
}

/** 这个动作历史最高的估算 1RM；没练过 / 算不出来返回 null */
function bestE1rm(exId) {
  const attrs = M.attrsOf(exId);
  if (!attrs) return null;
  const rows = (db.allSets() || []).filter(function (s) {
    return s && s.done !== false && !s.warmup && !s.demo && s.exId === exId;
  });
  if (!rows.length) return null;

  const best = P.pickBest(rows, attrs, P.bodyweightAtFactory());
  if (!best || !(best.value > 0)) return null;
  // 自重动作还没记体重时 pickBest 会退回「次数」，那不是负荷，不能拿去评级
  if (best.noLoad) return null;
  return best;
}

/**
 * 页面要的整块数据。
 * @returns {{
 *   ready: boolean, reason: 'no-sex'|'no-weight'|'no-data'|'',
 *   sex: string, bw: number, age: number, items: Array
 * }}
 */
function strengthNow() {
  const prof = db.profile() || {};
  const sex = prof.sex === 'f' ? 'f' : (prof.sex === 'm' ? 'm' : '');
  const bw = latestWeight();
  const out = {
    show: true,          // 力量水平这一栏默认就显示（缺资料时显示「缺什么」）
    ready: false,
    reason: '',
    sex: sex,
    sexCn: sex === 'f' ? '女' : (sex === 'm' ? '男' : ''),
    bw: bw,
    age: ageOf(prof.birthYear),
    items: []
  };

  if (!sex) { out.reason = 'no-sex'; return out; }
  if (!(bw > 0)) { out.reason = 'no-weight'; return out; }

  out.items = STD.LIFTS.map(function (lift) {
    const best = bestE1rm(lift.exId);
    if (!best) return null;

    const ratio = Math.round((best.value / bw) * 100) / 100;
    const lv = levelFor(ratio, STD.thresholdsOf(lift.exId, sex));
    return {
      exId: lift.exId,
      cn: lift.cn,
      e1rm: Math.round(best.value * 10) / 10,
      ratio: ratio,
      level: lv.name,
      levelIdx: lv.idx,
      next: lv.next,
      toNext: lv.toNext,
      // 五档进度：数组里每项带下标（wx:key 要用），on = 这一档到过没有
      dots: STD.LEVELS.map(function (_, i) { return { i: i, on: i <= lv.idx }; })
    };
  }).filter(Boolean);

  out.ready = out.items.length > 0;
  if (!out.ready) out.reason = 'no-data';
  return out;
}

module.exports = { strengthNow, levelFor, latestWeight, ageOf, bestE1rm };
