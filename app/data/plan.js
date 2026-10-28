/**
 * 计划模板
 *
 * 用户首次进入时选三件事，这里负责把选择变成一个真正的周计划：
 *   level  水平  new（刚开始） / some（练过一阵） / trained（一直在练）
 *   days   一周练几次  2 / 3 / 4
 *   place  在哪练  gym（健身房） / home（居家）
 *
 * 输出格式与 db.todayPlan() 需要的完全一致：{ 星期几: { name, en, items } }
 */

const EX = require('./exercises');

/* ---------------- 水平 → 组数次数 ---------------- */

const LEVEL = {
  new:     { sets: 3, repsKg: 12, repsBw: 10, sec: 30, wf: 0.6  },
  some:    { sets: 4, repsKg: 10, repsBw: 12, sec: 45, wf: 1.0  },
  trained: { sets: 4, repsKg: 8,  repsBw: 15, sec: 60, wf: 1.25 }
};

/* ---------------- 健身房动作的基线重量（some 水平的重量） ---------------- */

const BASE_WEIGHT = {
  g1: 50, g2: 14, g3: 25, g4: 8, g6: 40,
  g7: 20, g8: 10, g9: 24, g10: 16, g11: 20, g12: 80
};

/* ---------------- 日类型：每个训练日练什么 ---------------- */

const DAY_TYPES = {
  gym: {
    push:   { name: '推日',   en: 'Push',      ex: ['g1', 'g2', 'g4', 'g3'] },
    pull:   { name: '拉日',   en: 'Pull',      ex: ['g5', 'g6', 'g7', 'g8'] },
    legs:   { name: '腿日',   en: 'Legs',      ex: ['g9', 'g11', 'g12', 'g13'] },
    upper:  { name: '上肢日', en: 'Upper',     ex: ['g1', 'g6', 'g5', 'g2'] },
    lower:  { name: '下肢日', en: 'Lower',     ex: ['g9', 'g11', 'g12', 'g14'] },
    fullA:  { name: '全身 A', en: 'Full A',    ex: ['g9', 'g1', 'g6', 'g13'] },
    fullB:  { name: '全身 B', en: 'Full B',    ex: ['g11', 'g2', 'g5', 'g10'] }
  },
  home: {
    push:   { name: '推日',   en: 'Push',      ex: ['h1', 'h3', 'h2'] },
    pull:   { name: '拉日',   en: 'Pull',      ex: ['h4', 'h5'] },
    legs:   { name: '腿日',   en: 'Legs',      ex: ['h6', 'h8', 'h7', 'h9'] },
    upper:  { name: '上肢日', en: 'Upper',     ex: ['h1', 'h4', 'h3', 'h11'] },
    lower:  { name: '下肢日', en: 'Lower',     ex: ['h6', 'h8', 'h7', 'h9'] },
    fullA:  { name: '全身 A', en: 'Full A',    ex: ['h6', 'h1', 'h5', 'h9'] },
    fullB:  { name: '全身 B', en: 'Full B',    ex: ['h8', 'h2', 'h4', 'h10'] }
  }
};

/* ---------------- 一周练几次 → 排在哪几天 / 按什么顺序 ---------------- */

// 周一=0 … 周日=6
const DAY_PATTERNS = {
  2: [1, 4],        // 周二、周五
  3: [0, 2, 4],     // 周一、周三、周五
  4: [0, 1, 3, 4]   // 周一、周二、周四、周五
};

const SCHEDULE = {
  2: ['fullA', 'fullB'],
  3: ['push', 'pull', 'legs'],
  4: ['upper', 'lower', 'upper', 'lower']
};

/* ---------------- 生成 ---------------- */

/** 重量取到 2.5kg 的整数倍（杠铃片最小单位） */
function roundWeight(w) {
  return Math.max(0, Math.round(w / 2.5) * 2.5);
}

function makeItems(exIds, lv) {
  const out = [];
  exIds.forEach(function (id) {
    const ex = EX.byId(id);
    if (!ex) return;

    if (ex.unit === 'sec') {
      out.push({ exId: id, sets: 3, reps: lv.sec, weight: 0, unit: 'sec' });
      return;
    }
    if (ex.unit === 'bw') {
      out.push({ exId: id, sets: lv.sets, reps: lv.repsBw, weight: 0, unit: 'bw' });
      return;
    }
    const base = BASE_WEIGHT[id] || 20;
    out.push({
      exId: id,
      sets: lv.sets,
      reps: lv.repsKg,
      weight: roundWeight(base * lv.wf),
      unit: 'kg'
    });
  });
  return out;
}

/**
 * 生成周计划
 * @returns { 星期几: { name, en, items: [{exId, sets, reps, weight, unit}] } }
 */
function buildPlan(days, place, level) {
  const d = DAY_PATTERNS[days] || DAY_PATTERNS[3];
  const order = SCHEDULE[days] || SCHEDULE[3];
  const types = DAY_TYPES[place === 'home' ? 'home' : 'gym'];
  const lv = LEVEL[level] || LEVEL.some;

  const plans = {};
  d.forEach(function (wd, i) {
    const t = types[order[i]] || types.fullA;
    plans[wd] = {
      name: t.name,
      en: t.en,
      items: makeItems(t.ex, lv)
    };
  });
  return plans;
}

/** 计划摘要，给「我的」页面或首页显示：「一周 3 练 · 健身房」 */
function describe(profile) {
  if (!profile) return '';
  return '一周 ' + profile.days + ' 练 · ' + (profile.place === 'home' ? '居家' : '健身房');
}

/* ---------------- 示例数据（用户主动点了才生成） ---------------- */

/**
 * 造一份过去四周的假记录，让数据页第一次不是空的。
 * 只按用户自己的计划生成，所以看起来就是他练的。
 */
function makeDemoSets(plans) {
  const D = require('../utils/date');
  const out = [];

  let s = 11;
  const rnd = function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  const today = D.today();
  const days = [];

  for (let i = 27; i >= 1; i--) {
    const day = D.shift(today, -i);
    const wd = D.weekdayMon(new Date(day + 'T00:00:00'));
    if (!plans[wd]) continue;                 // 休息日跳过
    const force = i <= 3;                     // 最近 3 天必练
    if (!force && rnd() >= 0.75) continue;
    days.push(day);
  }

  days.forEach(function (day, di) {
    const wd = D.weekdayMon(new Date(day + 'T00:00:00'));
    const plan = plans[wd];
    const bump = di > days.length / 2 ? 1.06 : 1;   // 后半段稍重，看得出进步

    plan.items.forEach(function (it) {
      const ex = EX.byId(it.exId) || { cn: it.exId, part: 'legs' };
      for (let k = 0; k < it.sets; k++) {
        out.push({
          id: day + '-' + it.exId + '-' + k,
          date: day,
          exId: it.exId,
          exCn: ex.cn,
          part: ex.part,
          setNo: k + 1,
          weight: it.weight ? roundWeight(it.weight * bump) : 0,
          reps: it.reps,
          unit: it.unit || 'kg',
          done: true
        });
      }
    });
  });

  return out;
}

module.exports = {
  LEVEL, BASE_WEIGHT, DAY_PATTERNS, SCHEDULE, DAY_TYPES,
  buildPlan, describe, makeDemoSets, roundWeight
};
