/**
 * 数据层（第一版：微信本地存储）
 *
 * 为什么单独一层：以后换成云开发，只改这个文件，
 * 页面调用的方法签名不变（都是同步返回，后续换云时再改 Promise）。
 *
 * 存储键：
 *   lj.onboarded  是否走完首次引导
 *   lj.profile    引导时的选择 { level, days, place }
 *   lj.plans      由 profile 生成的周计划
 *   lj.sets       组记录
 */

const EX = require('../data/exercises');
const P = require('../data/plan');
const D = require('../utils/date');
const V = require('../utils/volume');

const K_ONBOARDED = 'lj.onboarded';
const K_PROFILE = 'lj.profile';
const K_PLAN = 'lj.plans';
const K_SETS = 'lj.sets';

/* ---------------- 引导 / 用户设置 ---------------- */

function hasOnboarded() {
  return !!wx.getStorageSync(K_ONBOARDED);
}

function profile() {
  return wx.getStorageSync(K_PROFILE) || null;
}

/** 生成并保存计划（改设置时也走这里） */
function saveProfile(p) {
  const prof = {
    level: p.level || 'some',
    days: Number(p.days) || 3,
    place: p.place === 'home' ? 'home' : 'gym'
  };
  const plans = P.buildPlan(prof.days, prof.place, prof.level);
  wx.setStorageSync(K_PROFILE, prof);
  wx.setStorageSync(K_PLAN, plans);
  return plans;
}

/** 走完引导（第一次进入时调用） */
function finishOnboarding(p) {
  saveProfile(p);
  wx.setStorageSync(K_ONBOARDED, true);
}

/**
 * 兼容旧版本存储。
 * 老版本没有引导，启动就写入写死的计划 + 126 条假记录（键 lj.seeded）。
 * 升级上来的人如果不清掉，走完引导后数据页还是旧的假数据。
 *
 * @returns {boolean} 是否清理过
 */
function migrate() {
  if (wx.getStorageSync('lj.seeded') && !hasOnboarded()) {
    wx.removeStorageSync(K_SETS);
    wx.removeStorageSync(K_PLAN);
    wx.removeStorageSync('lj.seeded');
    return true;
  }
  return false;
}

function profileText() {
  const p = profile();
  return p ? P.describe(p) : '';
}

/* ---------------- 动作 ---------------- */

function exercises() {
  return EX.EXERCISES;
}

function exerciseById(id) {
  return EX.byId(id);
}

/* ---------------- 计划 ---------------- */

function plans() {
  return wx.getStorageSync(K_PLAN) || {};
}

/**
 * 今天练什么。
 * 返回 { rest: true } 或 { name, en, items: [{ exId, cn, en, part, sets, reps, weight, unit }] }
 */
function todayPlan(date) {
  const day = date || D.today();
  const wd = D.weekdayMon(new Date(day + 'T00:00:00'));
  const plan = plans()[wd];
  if (!plan) return { rest: true, weekday: wd };

  const items = plan.items.map(function (it) {
    const ex = exerciseById(it.exId) || { cn: it.exId, en: '', part: 'legs' };
    return {
      exId: it.exId,
      cn: ex.cn,
      en: ex.en,
      part: ex.part,
      sets: it.sets,
      reps: it.reps,
      weight: it.weight,
      unit: it.unit || 'kg'
    };
  });

  return { rest: false, name: plan.name, en: plan.en, weekday: wd, items: items };
}

/* ---------------- 记录 ---------------- */

function allSets() {
  return wx.getStorageSync(K_SETS) || [];
}

/** 保存一组，同一天同动作同组号覆盖 */
function saveSet(rec) {
  const all = allSets();
  const id = rec.date + '-' + rec.exId + '-' + rec.setNo;
  const idx = all.findIndex(function (s) { return s.id === id; });
  const row = {
    id: id,
    date: rec.date,
    exId: rec.exId,
    exCn: rec.exCn,
    part: rec.part,
    setNo: rec.setNo,
    weight: Number(rec.weight) || 0,
    reps: Number(rec.reps) || 0,
    unit: rec.unit || 'kg',
    done: true
  };
  if (idx >= 0) all[idx] = row; else all.push(row);
  wx.setStorageSync(K_SETS, all);
  return row;
}

/** 今天的记录 */
function todaySets(date) {
  const day = date || D.today();
  return allSets().filter(function (s) { return s.date === day && s.done; });
}

/** 有没有练过（判断首页空态用） */
function hasAnyRecord() {
  return allSets().some(function (s) { return s.done; });
}

/** 上次练这个动作是什么时候、多少重量 */
function lastRecord(exId, beforeDate) {
  const before = beforeDate || D.today();
  const all = allSets().filter(function (s) {
    return s.exId === exId && s.done && s.date < before;
  });
  if (!all.length) return null;

  const lastDay = all.reduce(function (a, b) { return a.date > b.date ? a : b; }).date;
  const daySets = all.filter(function (s) { return s.date === lastDay; });
  return {
    date: lastDay,
    weight: daySets[0].weight,
    reps: daySets[0].reps,
    sets: daySets.length,
    daysAgo: D.diffDays(before, lastDay)
  };
}

/** 某动作在今天之前的最大重量（判断 PR 用）；没练过返回 0 */
function maxWeightBefore(exId, beforeDate) {
  const before = beforeDate || D.today();
  let max = 0;
  allSets().forEach(function (s) {
    if (s.exId !== exId || !s.done || s.date >= before) return;
    if (s.unit !== 'kg' || !(s.weight > max)) return;
    max = s.weight;
  });
  return max;
}

/* ---------------- 示例数据 ---------------- */

/**
 * 造一份示例记录。只在用户主动点「先看看长什么样」时调用。
 * 按用户自己的计划生成，所以看起来就是他练的。
 */
function loadDemo() {
  const p = plans();
  if (!Object.keys(p).length) return 0;
  const rows = P.makeDemoSets(p);
  wx.setStorageSync(K_SETS, rows);
  return rows.length;
}

function clearSets() {
  wx.setStorageSync(K_SETS, []);
}

/** 彻底清空（重走引导用，调试也有用） */
function resetAll() {
  wx.removeStorageSync(K_ONBOARDED);
  wx.removeStorageSync(K_PROFILE);
  wx.removeStorageSync(K_PLAN);
  wx.removeStorageSync(K_SETS);
}

/* ---------------- 训练战报 ---------------- */

/**
 * 找今天的 PR（只算负重动作）。
 * 第一次做的动作不算 PR —— 否则头一个月什么都没干，天天「新纪录」，就不值钱了。
 */
function detectPRs(date) {
  const day = date || D.today();
  const rows = allSets().filter(function (s) { return s.date === day && s.done; });

  // 今天每个动作的最大重量
  const cur = {};
  rows.forEach(function (s) {
    if (s.unit !== 'kg' || !(s.weight > 0)) return;
    if (!cur[s.exId] || s.weight > cur[s.exId].weight) {
      cur[s.exId] = { cn: s.exCn, weight: s.weight };
    }
  });

  // 历史上（今天之前）每个动作的最大重量
  const hist = {};
  allSets().forEach(function (s) {
    if (!s.done || s.date >= day) return;
    if (s.unit !== 'kg' || !(s.weight > 0)) return;
    if (!hist[s.exId] || s.weight > hist[s.exId]) hist[s.exId] = s.weight;
  });

  const prs = [];
  Object.keys(cur).forEach(function (id) {
    const old = hist[id];
    if (old === undefined) return;                 // 第一次做，不算
    if (cur[id].weight > old) {
      prs.push({
        exId: id,
        cn: cur[id].cn,
        weight: cur[id].weight,
        prev: old,
        delta: Math.round((cur[id].weight - old) * 10) / 10
      });
    }
  });

  return prs.sort(function (a, b) { return b.delta - a.delta; });
}

/** 今天这次训练的汇总，给战报页用 */
function todayReport(date) {
  const day = date || D.today();
  const rows = allSets().filter(function (s) { return s.date === day && s.done; });
  const plan = todayPlan(day);

  const exSeen = {};
  const partSets = {};
  rows.forEach(function (s) {
    exSeen[s.exId] = true;
    partSets[s.part] = (partSets[s.part] || 0) + 1;
  });

  const totalSets = rows.length || 1;
  const parts = Object.keys(partSets).map(function (k) {
    return { key: k, name: EX.PART_CN[k] || k, pct: Math.round(partSets[k] / totalSets * 100) };
  }).sort(function (a, b) { return b.pct - a.pct; });

  const volume = V.totalVolume(rows);
  const plannedSets = plan.rest
    ? 0
    : plan.items.reduce(function (a, it) { return a + it.sets; }, 0);

  return {
    date: day,
    planName: plan.rest ? '自由训练' : plan.name,
    sets: rows.length,
    plannedSets: plannedSets,
    exercises: Object.keys(exSeen).length,
    volume: volume,
    ton: V.toTon(volume),
    parts: parts,
    prs: detectPRs(day),
    week: weeklyProgress()
  };
}

/* ---------------- 统计 ---------------- */

/**
 * 本周进度：这周练了几天 / 计划练几天
 * （计划是隔天练时，「连续天数」永远只有 1，没有意义，所以用本周进度）
 */
function weeklyProgress() {
  const wd = D.weekdayMon();
  const monday = D.shift(D.today(), -wd);

  const daySet = {};
  allSets().filter(function (s) { return s.done; })
    .forEach(function (s) { daySet[s.date] = true; });

  let done = 0;
  for (let i = 0; i < 7; i++) {
    if (daySet[D.shift(monday, i)]) done++;
  }

  return { done: done, planned: Object.keys(plans()).length };
}

/**
 * 某月统计：
 * { days, streak, ton, calendar: [{d, on, today}], parts: [{name, pct}], top: [{cn, count}] }
 */
function monthlyStats(y, m) {
  const pre = y + '-' + D.pad(m) + '-';
  const all = allSets().filter(function (s) { return s.done; });
  const inMonth = all.filter(function (s) { return s.date.indexOf(pre) === 0; });

  // 训练日
  const daySet = {};
  inMonth.forEach(function (s) { daySet[s.date] = true; });
  const days = Object.keys(daySet).length;

  // 连续天数：今天还没练不算断签，从昨天往前数
  const allDaySet = {};
  all.forEach(function (s) { allDaySet[s.date] = true; });
  let streak = 0;
  let cursor = D.today();
  if (!allDaySet[cursor]) cursor = D.shift(cursor, -1);
  while (allDaySet[cursor]) {
    streak++;
    cursor = D.shift(cursor, -1);
  }

  // 容量
  const ton = V.toTon(V.totalVolume(inMonth));

  // 日历
  const todayS = D.today();
  const dim = D.daysInMonth(y, m);
  const calendar = [];
  for (let d = 1; d <= dim; d++) {
    const ds = pre + D.pad(d);
    calendar.push({ d: d, on: !!daySet[ds], today: ds === todayS });
  }

  // 部位分布：按「练了多少组」算，比按容量更直观
  // （按容量的话，腿因为重量大会被放大到七八成，看起来像只有腿在练）
  const partSets = {};
  inMonth.forEach(function (s) {
    partSets[s.part] = (partSets[s.part] || 0) + 1;
  });
  const totalSets = Object.keys(partSets).reduce(function (a, k) { return a + partSets[k]; }, 0) || 1;
  const parts = Object.keys(partSets)
    .map(function (k) {
      return { key: k, name: EX.PART_CN[k] || k, pct: Math.round(partSets[k] / totalSets * 100) };
    })
    .sort(function (a, b) { return b.pct - a.pct; });

  // 动作频次（按天去重：练过几次，不是几组）
  const exDays = {};
  inMonth.forEach(function (s) {
    const k = s.exId;
    if (!exDays[k]) exDays[k] = { cn: s.exCn, days: {} };
    exDays[k].days[s.date] = true;
  });
  const top = Object.keys(exDays)
    .map(function (k) {
      return { cn: exDays[k].cn, count: Object.keys(exDays[k].days).length };
    })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 5);

  return { days: days, streak: streak, ton: ton, calendar: calendar, parts: parts, top: top };
}

module.exports = {
  /* 引导 */
  hasOnboarded, profile, saveProfile, finishOnboarding, profileText, migrate, resetAll,
  /* 动作 */
  exercises, exerciseById,
  /* 计划 */
  plans, todayPlan,
  /* 记录 */
  allSets, saveSet, todaySets, hasAnyRecord, lastRecord, maxWeightBefore, clearSets, loadDemo,
  /* 战报 */
  todayReport, detectPRs,
  /* 统计 */
  monthlyStats, weeklyProgress
};
