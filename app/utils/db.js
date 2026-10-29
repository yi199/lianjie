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
const K_SWAPS = 'lj.swaps';   // 训练日里「第几个动作 → 换成哪个」，跟着计划走

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
  const oldSig = planSig();
  const plans = P.buildPlan(prof.days, prof.place, prof.level);
  wx.setStorageSync(K_PROFILE, prof);
  wx.setStorageSync(K_PLAN, plans);

  // 训练日编号的含义变了（A 从「推日」变「上肢 A」），旧的换动作记录不能再用
  if (oldSig && oldSig !== planSig()) wx.removeStorageSync(K_SWAPS);

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

/** 这个动作第一次做该上多重（按用户当前水平算） */
function initialWeight(exId) {
  return P.initialWeight(exId, (profile() || {}).level);
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

/* ---------------- 换动作（训练日里永久替换） ---------------- */

/**
 * 换过的动作。
 * 存的是「训练日 key + 第几个动作」→ 新动作 id，不按日期，
 * 所以换一次以后这个训练日一直是新动作，不用每天重换。
 */
function swaps() {
  return wx.getStorageSync(K_SWAPS) || {};
}

function setSwap(planKey, slot, exId) {
  const sw = swaps();
  const list = plans();
  const p = list.filter(function (x) { return x.key === planKey; })[0];
  const origin = p && p.items[slot] ? p.items[slot].exId : '';

  // 换回原动作等于没换，别留一条「换成同一个动作」的脏记录
  if (origin && origin === exId) delete sw[planKey + ':' + slot];
  else sw[planKey + ':' + slot] = exId;

  wx.setStorageSync(K_SWAPS, sw);
  return sw;
}

function clearSwap(planKey, slot) {
  const sw = swaps();
  delete sw[planKey + ':' + slot];
  wx.setStorageSync(K_SWAPS, sw);
  return sw;
}

/** 把模板里的动作 id 展开成完整动作，并应用换过的动作 */
function decorate(p) {
  const sw = swaps();
  return {
    key: p.key,
    type: p.type,
    name: p.name,
    en: p.en,
    items: p.items.map(function (it, i) {
      const altId = sw[p.key + ':' + i];
      const useAlt = !!(altId && EX.byId(altId));
      const exId = useAlt ? altId : it.exId;
      const ex = EX.byId(exId) || { cn: exId, en: '', part: 'legs', unit: 'kg' };
      const origin = EX.byId(it.exId);

      return {
        exId: exId,
        cn: ex.cn,
        en: ex.en,
        part: ex.part,
        tips: ex.tips || '',
        slot: i,
        sets: it.sets,
        reps: it.reps,
        weight: useAlt ? P.initialWeight(exId, (profile() || {}).level) : it.weight,
        unit: ex.unit || it.unit || 'kg',
        swapped: useAlt,
        originCn: useAlt && origin ? origin.cn : ''
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

/* ---------------- 训练日轮转 ---------------- */

/** 当前计划签名（设置变了，旧记录就不再对应现在的 A/B/C） */
function planSig() {
  return P.planSig(profile());
}

/**
 * 某一天的记录属于哪个训练日。
 * 优先看记录里的 planKey；老记录没带 planKey 的，用「做过哪些动作」反推最像的那个。
 */
function dayKey(rows) {
  const cnt = {};
  rows.forEach(function (s) {
    if (!s.planKey) return;
    cnt[s.planKey] = (cnt[s.planKey] || 0) + 1;
  });
  const keys = Object.keys(cnt);
  if (keys.length) {
    return keys.sort(function (a, b) { return cnt[b] - cnt[a]; })[0];
  }

  const list = plans();
  const exIds = {};
  rows.forEach(function (s) { exIds[s.exId] = true; });
  let best = '';
  let bestHit = 0;
  list.forEach(function (p) {
    const hit = p.items.filter(function (it) { return exIds[it.exId]; }).length;
    if (hit > bestHit) { bestHit = hit; best = p.key; }
  });
  return best;
}

/**
 * 已经练过的训练日序列（按日期升序），只认当前计划签名、且日期早于 beforeDate 的记录。
 */
function sessionDays(beforeDate) {
  const sig = planSig();
  const byDate = {};
  allSets().forEach(function (s) {
    if (!s.done) return;
    if (s.sig && s.sig !== sig) return;          // 改设置之前的老记录，不参与轮转
    if (beforeDate && s.date >= beforeDate) return;
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  });
  return Object.keys(byDate).sort().map(function (d) {
    return { date: d, key: dayKey(byDate[d]) };
  });
}

/**
 * 下一个该练的训练日。
 *
 * 关键是「接着上一次练的那天往下排」，不是「本周练了几次 % 模板数」——
 * 后者只要一周没练满目标次数，就会永远在 A/B 之间打转，C 一辈子轮不到。
 */
function nextKey(beforeDate) {
  const list = plans();
  if (!list.length) return null;

  const days = sessionDays(beforeDate);
  if (!days.length) return list[0];

  const lastKey = days[days.length - 1].key;
  const idx = list.findIndex(function (p) { return p.key === lastKey; });
  if (idx < 0) return list[0];
  return list[(idx + 1) % list.length];
}

/**
 * 今天该练什么。
 *
 *   今天已经练过 → 继续当天那个训练日
 *   否则 → 接着上一次训练往下排（跨周连续，不会漏掉某个训练日）
 *   本周达标 → finished，但仍给下一个模板，允许加练
 *
 * @returns {{ finished, resumed, plan, week:{done,target}, today:{doneEx,totalEx,complete,rows}, list }}
 */
function todaySession(date) {
  const list = plans();
  const prof = profile() || {};
  const target = Number(prof.days) || list.length || 3;
  const today = date || D.today();
  const week = weekDates(today);

  const rows = allSets().filter(function (s) { return s.done; });
  const todayRows = rows.filter(function (s) { return s.date === today; });
  const hasToday = todayRows.length > 0;

  // 本周进度：按「练了几天」算，一天练两次也只算一次
  const daySet = {};
  rows.forEach(function (s) {
    if (week.indexOf(s.date) >= 0) daySet[s.date] = true;
  });
  const done = Object.keys(daySet).length;
  const finished = done >= target;

  // 今天练的是哪个训练日：先认记录，认不出来再接着排队
  let raw = null;
  if (hasToday) {
    const k = dayKey(todayRows);
    raw = list.filter(function (p) { return p.key === k; })[0] || null;
  }
  if (!raw) raw = nextKey(today);
  if (!raw && list.length) raw = list[0];

  const plan = raw ? decorate(raw) : null;

  // 今天做到哪了：按当前训练日的动作逐个对，换过动作也算
  const doneEx = {};
  todayRows.forEach(function (s) { doneEx[s.exId] = true; });
  const totalEx = plan ? plan.items.length : 0;
  const hitEx = plan
    ? plan.items.filter(function (it) { return doneEx[it.exId]; }).length
    : 0;

  return {
    finished: finished,
    resumed: hasToday,
    plan: plan,
    week: { done: done, target: target },
    today: {
      doneEx: hitEx,
      totalEx: totalEx,
      complete: hasToday && totalEx > 0 && hitEx >= totalEx,
      rows: todayRows.length
    },
    list: list
  };
}

/* ---------------- 重量建议（渐进超负荷） ---------------- */

/**
 * 建议今天这个动作练多重。
 *
 * 规则：上次同一动作，「组数做够」且「每组次数都达标」→ 加一档；否则保持。
 *   下肢 +5kg，其它 +2.5kg（取 2.5 的整数倍）
 *
 * 两个坑专门防住：
 *   1) 只勾了 1 组就退出，不能算「全部完成」——必须组数也够；
 *   2) 基准取当天最重的一组，用户中途减重不该把下次的起点拉低。
 *
 * @param {string} exId
 * @param {number} planReps 计划次数
 * @param {number} planSets 计划组数
 * @param {string} [date]
 * @returns {{weight, reason:'first'|'up'|'keep', prev, step, date, sets, enoughSets}}
 */
function suggestWeight(exId, planReps, planSets, date) {
  const day = date || D.today();
  const ex = EX.byId(exId);

  const rows = allSets().filter(function (s) {
    return s.done && s.exId === exId && s.date < day && s.unit === 'kg' && s.weight > 0;
  });
  if (!rows.length) {
    return { weight: 0, reason: 'first', prev: 0, step: 0, date: '', sets: 0, enoughSets: false };
  }

  const lastDay = rows.reduce(function (a, b) { return a.date > b.date ? a : b; }).date;
  const lastRows = rows.filter(function (s) { return s.date === lastDay; });

  const base = lastRows.reduce(function (a, b) {
    return b.weight > a.weight ? b : a;
  }).weight;

  const needSets = Number(planSets) || 0;
  const enoughSets = lastRows.length >= needSets;
  const allHit = lastRows.every(function (s) { return s.reps >= (planReps || 0); });
  const step = (ex && ex.part === 'legs') ? 5 : 2.5;

  if (enoughSets && allHit) {
    return {
      weight: P.roundWeight(base + step),
      reason: 'up',
      prev: base,
      step: step,
      date: lastDay,
      sets: lastRows.length,
      enoughSets: true
    };
  }
  return {
    weight: base,
    reason: 'keep',
    prev: base,
    step: 0,
    date: lastDay,
    sets: lastRows.length,
    enoughSets: enoughSets
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
    planKey: rec.planKey || '',
    sig: planSig(),
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
 *
 * 已经练过的用户不给覆盖 —— 示例数据把真实记录冲掉是不可接受的。
 * @returns {number} 生成的条数；-1 表示已有真实记录，没动
 */
function loadDemo() {
  const list = plans();
  const prof = profile() || {};
  if (!list.length) return 0;
  if (hasAnyRecord()) return -1;
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
  wx.removeStorageSync(K_SWAPS);
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

/**
 * 力量地形用的部位强度。
 * 固定返回 6 个部位（没练过的记 0），这样多边形形状才稳定，
 * 不会因为某个部位没数据就塌掉一个角。
 */
const TERRAIN_KEYS = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core'];

function partTerrain(y, m) {
  const st = monthlyStats(y, m);
  const map = {};
  st.parts.forEach(function (p) { map[p.key] = p.pct; });

  return TERRAIN_KEYS.map(function (k) {
    const pct = map[k] || 0;
    return { key: k, name: EX.PART_CN[k] || k, pct: pct, trained: pct > 0 };
  });
}

/**
 * 近 n 周的训练量（吨），给柱状图用。
 * 返回从最早到最近：[{ label, ton }]
 */
function weeklyVolume(n) {
  const weeks = Number(n) || 8;
  const wd = D.weekdayMon();
  const thisMonday = D.shift(D.today(), -wd);
  const all = allSets().filter(function (s) { return s.done; });

  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = D.shift(thisMonday, -i * 7);
    const end = D.shift(start, 6);
    const rows = all.filter(function (s) { return s.date >= start && s.date <= end; });
    out.push({
      label: i === 0 ? '本周' : '-' + i + 'w',
      ton: V.toTon(V.totalVolume(rows)),
      sets: rows.length
    });
  }
  return out;
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
  exercises, exerciseById, alternatives, initialWeight,
  /* 计划 */
  plans, todaySession, suggestWeight, planSig,
  /* 换动作 */
  swaps, setSwap, clearSwap,
  /* 记录 */
  allSets, saveSet, todaySets, hasAnyRecord, lastRecord, maxWeightBefore, clearSets, loadDemo,
  /* 战报 */
  todayReport, detectPRs,
  /* 统计 */
  monthlyStats, weeklyProgress,
  /* 可视化 */
  partTerrain, weeklyVolume
};
