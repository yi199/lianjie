/**
 * 数据层（第一版：微信本地存储）
 *
 * 为什么单独一层：以后换成云开发，只改这个文件，
 * 页面调用的方法签名不变（都是同步返回，后续换云时再改 Promise）。
 *
 * 存储键：
 *   lj.onboarded  是否走完首次引导
 *   lj.profile    引导时的选择 { level, days, place }
 *   lj.plans      训练日模板队列（数组，不是按星期的对象）
 *   lj.sets       组记录（每条带 planKey，标记这次属于哪个训练日）
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
 * 1) 老版本没有引导，启动就写入写死的计划 + 126 条假记录（键 lj.seeded）
 * 2) 老版本的 plans 是按星期的对象，现在是训练日队列数组
 */
function migrate() {
  let changed = false;

  if (wx.getStorageSync('lj.seeded') && !hasOnboarded()) {
    wx.removeStorageSync(K_SETS);
    wx.removeStorageSync(K_PLAN);
    wx.removeStorageSync('lj.seeded');
    changed = true;
  }

  const p = wx.getStorageSync(K_PLAN);
  if (p && !Array.isArray(p) && Object.keys(p).length) {
    const prof = profile();
    if (prof) {
      wx.setStorageSync(K_PLAN, P.buildPlan(prof.days, prof.place, prof.level));
    } else {
      wx.removeStorageSync(K_PLAN);
    }
    changed = true;
  }

  return changed;
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

/** 同部位、同场所的其它动作（换动作用）。场所跟着动作本身走，不看用户设置 */
function alternatives(exId) {
  const ex = EX.byId(exId);
  if (!ex) return [];
  return EX.alternatives(exId, ex.place);
}

/* ---------------- 计划 ---------------- */

/** 训练日模板队列：[{ key:'A', type, name, en, items }] */
function plans() {
  const p = wx.getStorageSync(K_PLAN);
  return Array.isArray(p) ? p : [];
}

/** 把模板里的动作 id 展开成完整动作 */
function decorate(p) {
  return {
    key: p.key,
    name: p.name,
    en: p.en,
    items: p.items.map(function (it) {
      const ex = EX.byId(it.exId) || { cn: it.exId, en: '', part: 'legs' };
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
    })
  };
}

/** 本周七天（周一 → 周日） */
function weekDates(date) {
  const base = date || D.today();
  const wd = D.weekdayMon(new Date(base + 'T00:00:00'));
  const monday = D.shift(base, -wd);
  const out = [];
  for (let i = 0; i < 7; i++) out.push(D.shift(monday, i));
  return out;
}

/**
 * 今天该练什么。
 *
 * 不按星期排，按「本周第几次」排队：
 *   今天已经练过 → 继续当天那个训练日
 *   否则 → 本周还没练的下一个模板
 *   本周达标 → finished，但仍给一个模板，允许加练
 *
 * @returns {{ finished, resumed, plan, week:{done,target}, list }}
 */
function todaySession(date) {
  const list = plans();
  const prof = profile() || {};
  const target = Number(prof.days) || list.length || 3;
  const today = date || D.today();
  const week = weekDates(today);
  const all = allSets().filter(function (s) { return s.done; });

  // 今天有没有练过
  const todayRows = all.filter(function (s) { return s.date === today; });
  const hasToday = todayRows.length > 0;
  const todayKey = hasToday ? (todayRows[0].planKey || '') : null;

  // 本周其它哪天练过（按日期去重）
  const otherDays = [];
  all.forEach(function (s) {
    if (s.date === today) return;
    if (week.indexOf(s.date) < 0) return;
    if (otherDays.indexOf(s.date) < 0) otherDays.push(s.date);
  });
  otherDays.sort();

  const done = otherDays.length + (hasToday ? 1 : 0);
  const finished = done >= target;
  const len = list.length || 1;

  let raw = null;
  if (hasToday) {
    raw = list.filter(function (p) { return p.key === todayKey; })[0]
      || list[otherDays.length % len]
      || null;
  } else if (finished) {
    raw = list[done % len] || list[0] || null;   // 达标了还给一个，允许加练
  } else {
    raw = list[otherDays.length % len] || null;
  }

  return {
    finished: finished,
    resumed: hasToday,
    plan: raw ? decorate(raw) : null,
    week: { done: done, target: target },
    list: list
  };
}

/* ---------------- 重量建议（渐进超负荷） ---------------- */

/**
 * 建议今天这个动作练多重。
 *
 * 规则：上次同一动作，所有组的次数都达标 → 加一档；没达标 → 保持。
 *   下肢 +5kg，其它 +2.5kg（取 2.5 的整数倍）
 *
 * @returns {{weight, reason:'first'|'up'|'keep', prev, step, date}}
 */
function suggestWeight(exId, planReps, date) {
  const day = date || D.today();
  const ex = EX.byId(exId);

  const rows = allSets().filter(function (s) {
    return s.done && s.exId === exId && s.date < day && s.unit === 'kg' && s.weight > 0;
  });
  if (!rows.length) return { weight: 0, reason: 'first', prev: 0, step: 0, date: '' };

  const lastDay = rows.reduce(function (a, b) { return a.date > b.date ? a : b; }).date;
  const lastRows = rows.filter(function (s) { return s.date === lastDay; });

  // 以最后一组为基准（用户可能中途减过重）
  const lastSet = lastRows.reduce(function (a, b) { return a.setNo > b.setNo ? a : b; });
  const base = lastSet.weight;

  const allHit = lastRows.every(function (s) { return s.reps >= (planReps || 0); });
  const step = (ex && ex.part === 'legs') ? 5 : 2.5;

  if (allHit) {
    return {
      weight: P.roundWeight(base + step),
      reason: 'up',
      prev: base,
      step: step,
      date: lastDay
    };
  }
  return { weight: base, reason: 'keep', prev: base, step: 0, date: lastDay };
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
    planKey: rec.planKey || '',
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
  const list = plans();
  const prof = profile() || {};
  if (!list.length) return 0;
  const rows = P.makeDemoSets(list, Number(prof.days) || list.length);
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

  const cur = {};
  rows.forEach(function (s) {
    if (s.unit !== 'kg' || !(s.weight > 0)) return;
    if (!cur[s.exId] || s.weight > cur[s.exId].weight) {
      cur[s.exId] = { cn: s.exCn, weight: s.weight };
    }
  });

  const hist = {};
  allSets().forEach(function (s) {
    if (!s.done || s.date >= day) return;
    if (s.unit !== 'kg' || !(s.weight > 0)) return;
    if (!hist[s.exId] || s.weight > hist[s.exId]) hist[s.exId] = s.weight;
  });

  const prs = [];
  Object.keys(cur).forEach(function (id) {
    const old = hist[id];
    if (old === undefined) return;
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

  // 计划名从记录的 planKey 找
  let planName = '自由训练';
  let plannedSets = 0;
  if (rows.length && rows[0].planKey) {
    const p = plans().filter(function (x) { return x.key === rows[0].planKey; })[0];
    if (p) {
      planName = p.name;
      plannedSets = p.items.reduce(function (a, it) { return a + it.sets; }, 0);
    }
  }

  const volume = V.totalVolume(rows);

  return {
    date: day,
    planName: planName,
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

/** 本周进度：这周练了几天 / 目标几天 */
function weeklyProgress() {
  const p = wx.getStorageSync(K_PROFILE) || {};
  const today = D.today();
  const week = weekDates();

  const daySet = {};
  allSets().filter(function (s) { return s.done; }).forEach(function (s) {
    if (week.indexOf(s.date) >= 0) daySet[s.date] = true;
  });

  return {
    done: Object.keys(daySet).length,
    planned: Number(p.days) || plans().length || 3
  };
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
  exercises, exerciseById, alternatives,
  /* 计划 */
  plans, todaySession, suggestWeight,
  /* 记录 */
  allSets, saveSet, todaySets, hasAnyRecord, lastRecord, maxWeightBefore, clearSets, loadDemo,
  /* 战报 */
  todayReport, detectPRs,
  /* 统计 */
  monthlyStats, weeklyProgress
};
