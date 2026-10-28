/**
 * 数据层（第一版：微信本地存储）
 *
 * 为什么要单独一层：以后换成云开发，只改这个文件，
 * 页面调用的方法签名不变（都是同步返回，后续换云时再改 Promise）。
 */

const seed = require('../data/seed');
const D = require('../utils/date');
const V = require('../utils/volume');

const K_EX = 'lj.exercises';
const K_PLAN = 'lj.plans';
const K_SETS = 'lj.sets';
const K_SEEDED = 'lj.seeded';

/* ---------------- 初始化 ---------------- */

function initSeed() {
  if (wx.getStorageSync(K_SEEDED)) return;
  wx.setStorageSync(K_EX, seed.EXERCISES);
  wx.setStorageSync(K_PLAN, seed.PLANS);
  wx.setStorageSync(K_SETS, seed.makeDemoSets());
  wx.setStorageSync(K_SEEDED, 1);
}

/** 清空所有数据（调试用） */
function resetAll() {
  wx.removeStorageSync(K_SEEDED);
  wx.removeStorageSync(K_SETS);
  initSeed();
}

/* ---------------- 动作 / 计划 ---------------- */

function exercises() {
  return wx.getStorageSync(K_EX) || seed.EXERCISES;
}

function exerciseById(id) {
  return exercises().filter(function (e) { return e.id === id; })[0] || null;
}

/**
 * 今天练什么。
 * 返回 { rest: true } 或 { name, en, items: [{ exId, cn, en, part, sets, reps, weight, unit }] }
 */
function todayPlan(date) {
  const day = date || D.today();
  const wd = D.weekdayMon(new Date(day + 'T00:00:00'));
  const plans = wx.getStorageSync(K_PLAN) || seed.PLANS;
  const plan = plans[wd];
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

/** 上次练这个动作是什么时候、多少重量 */
function lastRecord(exId, beforeDate) {
  const all = allSets().filter(function (s) {
    return s.exId === exId && s.done && s.date < (beforeDate || D.today());
  });
  if (!all.length) return null;

  const lastDay = all.reduce(function (a, b) { return a.date > b.date ? a : b; }).date;
  const daySets = all.filter(function (s) { return s.date === lastDay; });
  return {
    date: lastDay,
    weight: daySets[0].weight,
    reps: daySets[0].reps,
    sets: daySets.length,
    daysAgo: D.diffDays(beforeDate || D.today(), lastDay)
  };
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

  const plans = wx.getStorageSync(K_PLAN) || seed.PLANS;
  const planned = Object.keys(plans).length;

  return { done: done, planned: planned };
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
      return { key: k, name: seed.PART_CN[k] || k, pct: Math.round(partSets[k] / totalSets * 100) };
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

/** 今天的记录（用于返回今日页时显示已完成） */
function todaySets(date) {
  const day = date || D.today();
  return allSets().filter(function (s) { return s.date === day && s.done; });
}

module.exports = {
  initSeed, resetAll,
  exercises, exerciseById, todayPlan, lastRecord,
  allSets, saveSet, todaySets,
  monthlyStats, weeklyProgress
};
