/**
 * 进步计算（P7 · V1 数据底座 + V2 数据层）
 *
 * 依据：docs/设计文档/进步可视化.md §4（统一动作模型）、§6（停滞事实）、§7（整体变化）
 *
 * 三条铁律：
 *   1. **纯函数**：输入是「全部组记录」，输出是算出来的结构，不落库、不建表（§9.1）。
 *      以后改系数只要重算，历史曲线自动按新口径走，不需要数据迁移。
 *   2. **参数全在 data/progress-model.js**：这里只有算法，不写死「卧推算复合动作」这类判断。
 *   3. **只陈述事实，不给训练建议**：停滞只说「已经 4 次没超过 50kg×10」，
 *      「该加重还是该减载」是健身规划（V5）的事。
 *
 * 文件末尾是给页面用的快捷入口（懒加载 db，避免 db → progress → db 成环）。
 */

const D = require('./date');
const M = require('../data/progress-model');

const MODEL_CN = { e1rm: '估算极限', reps: '次数', duration: '时长', ladder: '进阶' };
const UNIT_CN = { kg: 'kg', reps: '次', duration: '秒', ladder: '级' };

/* ================= 小工具 ================= */

function cat() { return require('./catalog'); }

function exOf(exId) {
  const e = cat().find(exId);
  return e || { id: exId, cn: exId, en: '', part: '', unit: 'kg' };
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/** 中位数（偶数取中间两个的平均） */
function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function sum(list) {
  return list.reduce(function (a, b) { return a + b; }, 0);
}

/** 最小二乘斜率：y 对 x 的回归斜率（只有 1 个点返回 0） */
function slopeOf(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = sum(xs) / n;
  const my = sum(ys) / n;
  let up = 0;
  let down = 0;
  for (let i = 0; i < n; i++) {
    up += (xs[i] - mx) * (ys[i] - my);
    down += (xs[i] - mx) * (xs[i] - mx);
  }
  return down ? up / down : 0;
}

/** 周一为起点的周键（YYYY-MM-DD） */
function weekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const wd = (d.getDay() + 6) % 7;          // 周一 = 0
  return D.shift(dateStr, -wd);
}

function round(v, n) {
  const p = Math.pow(10, n === undefined ? 2 : n);
  return Math.round(v * p) / p;
}

/* ================= 实际负荷（§4.2） ================= */

/**
 * 这一组的实际负荷 = 体重 × 体重系数 + 外加重量 − 助力
 * 负重动作（系数 0）自动退化成「外加重量」；缺体重时自重动作返回 null（下游退回看次数）。
 */
function loadOf(set, attrs, bodyweightAt) {
  if (attrs.unit === 'sec') return null;
  const extra = num(set.weight);
  const assist = num(set.assist);
  if (attrs.unit === 'bw') {
    const bw = bodyweightAt ? bodyweightAt(set.date) : null;
    if (!(bw > 0)) return null;
    return round(bw * attrs.bwFactor + extra - assist, 1);
  }
  return round(extra - assist, 1);
}

/* ================= 力量值（§4.3 / §5） ================= */

/** 估算 1RM：重量 × (1 + (次数 + 剩余次数) / 30)，不录剩余次数按「刚好」= 1 */
function e1rm(load, reps, rir) {
  if (!(load > 0) || !(reps > 0)) return 0;
  const r = rir === null || rir === undefined ? M.PARAMS.defaultRir : rir;
  return round(load * (1 + (reps + r) / 30), 1);
}

/**
 * 一天里取哪一组定力量值（§5.3）：
 * 估算极限模型取「估算值最高、次数在可信上限内」的那组；超上限的组只作为兜底。
 * 次数 / 时长模型取最多次（最长秒数）；阶梯模型取最高级别那组。
 */
function pickBest(sets, attrs, bodyweightAt) {
  const scored = sets.map(function (s) {
    const load = loadOf(s, attrs, bodyweightAt);
    return { set: s, load: load, reps: num(s.reps), rir: s.rir };
  });

  if (attrs.model === M.MODEL.E1RM) {
    const withLoad = scored.filter(function (x) { return x.reps > 0 && x.load > 0; });
    if (withLoad.length) {
      // 次数超可信上限的组不剔除，而是把次数夹到上限再估算（§5.1：10 次以上 Epley 不准）。
      // 为什么不能「退回次数」：那会让序列中途换单位（kg → 次），看起来像暴跌。
      const eff = function (x) {
        return e1rm(x.load, Math.min(x.reps, attrs.credReps), x.rir);
      };
      withLoad.sort(function (a, b) { return eff(b) - eff(a); });
      const top = withLoad[0];
      return {
        value: eff(top),
        load: top.load,
        set: top.set,
        capped: top.reps > attrs.credReps,
        noLoad: false
      };
    }
    // 完全没有负荷（自重动作还没记体重）→ 只能退回看次数
    const withReps = scored.filter(function (x) { return x.reps > 0; });
    withReps.sort(function (a, b) { return b.reps - a.reps; });
    if (!withReps.length) return null;
    return {
      value: withReps[0].reps,
      load: null,
      set: withReps[0].set,
      capped: false,
      noLoad: true
    };
  }

  if (attrs.model === M.MODEL.DURATION) {
    const ok = scored.filter(function (x) { return x.reps > 0; });
    if (!ok.length) return null;
    ok.sort(function (a, b) { return b.reps - a.reps; });
    return { value: ok[0].reps, load: null, set: ok[0].set, capped: false, noLoad: false };
  }

  if (attrs.model === M.MODEL.LADDER) {
    const ok = scored.filter(function (x) { return x.reps > 0; });
    if (!ok.length) return null;
    ok.sort(function (a, b) { return b.reps - a.reps; });
    // 力量值 = 级别 + 次数/100：升一级即使次数掉一半，值仍然变大（§4.3）
    return {
      value: round(attrs.level + Math.min(ok[0].reps, 99) / 100, 2),
      load: ok[0].load,
      set: ok[0].set,
      capped: false,
      noLoad: false
    };
  }

  // REPS：单组最多次数（相同负荷下；不同负荷时取次数最多的那组，负荷单独带出去）
  const ok = scored.filter(function (x) { return x.reps > 0; });
  if (!ok.length) return null;
  ok.sort(function (a, b) { return b.reps - a.reps; });
  return { value: ok[0].reps, load: ok[0].load, set: ok[0].set, capped: false, noLoad: false };
}

/** 可信度（§4.4）：只做降档，不给假的高分 */
function confidenceOf(best, setCount, attrs) {
  let score = 3;
  if (setCount < 2) score -= 1;                                  // 只做了 1 组
  if (best.capped) score -= 1;                                   // 次数超出可信上限
  if (best.noLoad && attrs.unit === 'bw') score -= 1;            // 缺体重，算不出实际负荷
  if (!attrs.bwFactorKnown && attrs.unit === 'bw') score -= 1;   // 体重系数是估的
  return score >= 3 ? '高' : (score === 2 ? '中' : '低');
}

/* ================= 单动作序列（§9.3） ================= */

/** 只算正式组：热身组重量轻，示例数据也不算真实统计（§10），除非显式要 */
function workSets(rows, opts) {
  const includeDemo = !!(opts && opts.includeDemo);
  return (rows || []).filter(function (s) {
    if (!s || s.done === false || s.warmup) return false;
    if (s.demo && !includeDemo) return false;
    return true;
  });
}

/**
 * 一个动作的完整序列：每次训练一行，按日期升序。
 *
 * @param {Array} rows          全部组记录（db.allSets()）
 * @param {string} exId
 * @param {{bodyweightAt?:function(string):number, from?:string, to?:string}} [opts]
 * @returns {{attrs:object, merged:boolean, ids:string[], items:Array}}
 */
function series(rows, exId, opts) {
  const o = opts || {};
  const attrs = M.attrsOf(exOf(exId));
  // 阶梯家族：同家族的动作合并成一条线（换变式不算换动作）
  const merged = attrs.model === M.MODEL.LADDER;
  const ids = merged ? M.familyIds(attrs.family) : [exId];

  const mine = workSets(rows, o).filter(function (s) {
    if (ids.indexOf(s.exId) === -1) return false;
    if (o.from && s.date < o.from) return false;
    if (o.to && s.date > o.to) return false;
    return true;
  });

  const byDate = {};
  mine.forEach(function (s) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  });

  const dates = Object.keys(byDate).sort();
  const items = [];
  let prevDate = '';

  dates.forEach(function (date, i) {
    const daySets = byDate[date];
    // 家族合并时，当天的属性要按「那组属于哪个动作」取（级别可能不同）
    const dayEx = merged ? exOf(daySets[0].exId) : exOf(exId);
    const dayAttrs = merged ? M.attrsOf(dayEx) : attrs;
    const best = pickBest(daySets, dayAttrs, o.bodyweightAt);
    if (!best) return;

    items.push({
      exposure: items.length + 1,
      date: date,
      gapDays: prevDate ? D.diffDays(date, prevDate) : 0,
      exId: daySets[0].exId,
      exCn: dayEx.cn,
      value: best.value,
      load: best.load,
      unit: best.load > 0 && dayAttrs.model === M.MODEL.E1RM ? 'kg' : UNIT_CN[dayAttrs.model],
      level: merged ? dayAttrs.level : 0,
      best: {
        weight: num(best.set.weight),
        reps: num(best.set.reps),
        rir: best.set.rir,
        assist: num(best.set.assist),
        unit: (best.set && best.set.unit) || dayAttrs.unit
      },
      sets: daySets.length,
      conf: confidenceOf(best, daySets.length, dayAttrs)
    });
    prevDate = date;
  });

  return { attrs: attrs, merged: merged, ids: ids, items: items };
}

/* ================= 单动作趋势（§9.3 / S1·S4） ================= */

/**
 * 趋势：起点 / 当前 / 最好 / 相对进步指数 / 斜率 / 距最好几次 / 停滞事实。
 * 练过不到 3 次返回 { ok:false, need:n }——数据太少不出趋势（§10）。
 */
function trend(rows, exId, opts) {
  const o = opts || {};
  const s = series(rows, exId, o);
  const items = s.items;
  const attrs = s.attrs;
  const need = Math.max(0, M.PARAMS.minExposures - items.length);

  const base = {
    exId: exId,
    cn: exOf(exId).cn,
    part: attrs.part,
    model: attrs.model,
    modelCn: MODEL_CN[attrs.model],
    merged: s.merged,
    ids: s.ids,
    exposures: items.length,
    items: items
  };

  if (!items.length) return Object.assign(base, { ok: false, need: M.PARAMS.minExposures });
  if (need > 0) return Object.assign(base, { ok: false, need: need, first: items[0] });

  const startVals = items.slice(0, M.PARAMS.startN).map(function (x) { return x.value; });
  const start = median(startVals);
  const cur = items[items.length - 1];
  // 原始最好成绩（界面展示用，取最早出现的那次）
  const bestItem = items.reduce(function (a, b) { return b.value > a.value ? b : a; });
  // 「有效最好」：只有超过噪声阈值的进步才算真的往前走了一步。
  // 涨 1% 不重置停滞计时，否则每次微涨都能把「卡住了」洗掉。
  const noise = M.PARAMS.noise;
  const anchor = items.reduce(function (a, b) {
    return b.value > a.value * (1 + noise) ? b : a;
  });

  const idx = items.map(function (x) { return x.exposure; });
  const vals = items.map(function (x) { return x.value; });
  const perExp = slopeOf(idx, vals);
  const days = D.diffDays(cur.date, items[0].date);

  const sinceBest = cur.exposure - anchor.exposure;
  // 停滞事实：距「有效最好」已经过了 N 次训练（有效的定义是超过噪声阈值，见上）
  const stalled = sinceBest >= M.PARAMS.stallAfter;

  return Object.assign(base, {
    ok: true,
    start: round(start, 2),
    startKind: items.length > M.PARAMS.startN ? 'median' + M.PARAMS.startN : 'first',
    current: cur.value,
    currentDate: cur.date,
    currentUnit: cur.unit,
    best: bestItem.value,
    bestDate: bestItem.date,
    bestExposure: bestItem.exposure,
    index: start > 0 ? round(cur.value / start, 3) : 0,
    bestIndex: start > 0 ? round(bestItem.value / start, 3) : 0,
    slopePerExposure: round(perExp, 3),
    slopePerWeek: days > 0 ? round(perExp * ((items.length - 1) / days) * 7, 3) : 0,
    sinceBest: sinceBest,
    firstDate: items[0].date,
    lastDate: cur.date,
    spanDays: days,
    conf: cur.conf,
    stall: {
      stalled: stalled,
      flatCount: sinceBest,
      sinceExposure: anchor.exposure,
      bestValue: anchor.value,          // 停滞的锚点（有效最好，含噪声阈值）
      bestDate: anchor.date,
      bestSet: anchor.best,
      rawBest: bestItem.value,          // 原始最高值（界面展示用）
      noise: noise
    }
  });
}

/* ================= 全部动作的列表与状态（§7.1-3） ================= */

/** 参与计算的「动作单元」：阶梯家族算一个，其余按 exId 一对一 */
function units(rows, opts) {
  const seen = {};
  const out = [];
  workSets(rows, opts).forEach(function (s) {
    const attrs = M.attrsOf(exOf(s.exId));
    const key = attrs.model === M.MODEL.LADDER ? 'fam:' + attrs.family : 'ex:' + s.exId;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ key: key, exId: s.exId, attrs: attrs });
  });
  return out;
}

/**
 * 动作列表：每个动作练了几次、现在多少、比起点强多少、状态是涨/平/掉。
 * 状态只按噪声阈值判（§5.5），不猜阶段。
 */
function actions(rows, opts) {
  const o = opts || {};
  const noise = M.PARAMS.noise;
  const out = [];

  units(rows, o).forEach(function (u) {
    const t = trend(rows, u.exId, o);
    const all = series(rows, u.exId, o).items;
    const sets = workSets(rows, o).filter(function (s) { return u.attrs.model === M.MODEL.LADDER ? M.familyIds(u.attrs.family).indexOf(s.exId) !== -1 : s.exId === u.exId; });
    out.push({
      exId: u.exId,
      cn: u.attrs.model === M.MODEL.LADDER ? u.attrs.familyName : exOf(u.exId).cn,
      part: u.attrs.part,
      model: u.attrs.model,
      modelCn: MODEL_CN[u.attrs.model],
      merged: u.attrs.model === M.MODEL.LADDER,
      exposures: all.length,
      sets: sets.length,
      volume: sum(sets.map(function (s) { return num(s.weight) * num(s.reps); })),
      index: t.ok ? t.index : 0,
      value: all.length ? all[all.length - 1].value : 0,
      unit: all.length ? all[all.length - 1].unit : '',
      best: t.ok ? t.best : (all.length ? all.reduce(function (a, b) { return b.value >= a.value ? b : a; }).value : 0),
      lastDate: all.length ? all[all.length - 1].date : '',
      ok: t.ok,
      need: t.need || 0,
      conf: t.ok ? t.conf : '',
      stall: t.ok ? t.stall : null,
      status: !t.ok ? 'new' : (t.index > 1 + noise ? 'up' : (t.index < 1 - noise ? 'down' : 'flat'))
    });
  });

  out.sort(function (a, b) { return (b.index || 0) - (a.index || 0); });
  return out;
}

/* ================= 整体变化（§7.2 / §7.3） ================= */

/**
 * 全身进步指数：Σ(动作相对进步指数 × 权重)，权重 = 该动作组数占比。
 * 练得多的动作影响大，偶尔做一次不会把结果带偏（§7.2）。
 */
function overall(rows, opts) {
  const o = opts || {};
  const list = actions(rows, o).filter(function (a) { return a.ok; });
  const totalSets = sum(list.map(function (a) { return a.sets; }));
  if (!list.length || !totalSets) return { ok: false, need: '练 3 次以上的动作还不够', index: 0, weeks: [], parts: [], actions: actions(rows, o) };

  list.forEach(function (a) { a.weight = a.sets / totalSets; });
  const index = sum(list.map(function (a) { return a.index * a.weight; }));

  // 按周序列：每周取「截至该周最后一次训练」的相对进步指数，权重固定用总占比
  const dates = [];
  list.forEach(function (a) {
    series(rows, a.exId, o).items.forEach(function (it) { dates.push(it.date); });
  });
  dates.sort();
  const weeks = [];
  if (dates.length) {
    const firstWeek = weekKey(dates[0]);
    const lastWeek = weekKey(dates[dates.length - 1]);
    let wk = firstWeek;
    let guard = 0;
    while (wk <= lastWeek && guard < 60) {
      let weightSum = 0;
      let valSum = 0;
      let trained = 0;
      list.forEach(function (a) {
        const items = series(rows, a.exId, o).items.filter(function (it) { return it.date <= wkEnd(wk); });
        if (!items.length) return;
        const startVals = items.slice(0, M.PARAMS.startN).map(function (x) { return x.value; });
        const st = median(startVals);
        if (!(st > 0)) return;
        const v = items[items.length - 1].value / st;
        valSum += v * a.weight;
        weightSum += a.weight;
        if (items[items.length - 1].date >= wk) trained++;
      });
      if (weightSum > 0) weeks.push({ week: wk, index: round(valSum / weightSum, 3), trained: trained });
      wk = D.shift(wk, 7);
      guard++;
    }
  }

  return {
    ok: true,
    index: round(index, 3),
    up: round((index - 1) * 100, 1),      // 比起点强了多少（%）
    weeks: weeks,
    parts: partProgress(rows, o),
    actions: list,
    from: dates[0] || '',
    to: dates[dates.length - 1] || ''
  };
}

function wkEnd(weekStart) { return D.shift(weekStart, 6); }

/**
 * 各肌群进步：把每个动作的「超出起点多少」按肌群参与度分摊（§7.3）。
 * 返回的 delta 是百分比（12.5 = 强了 12.5%），按强弱排序。
 */
function partProgress(rows, opts) {
  const o = opts || {};
  const list = actions(rows, o).filter(function (a) { return a.ok; });
  const parts = {};
  const totalSets = sum(list.map(function (a) { return a.sets; })) || 1;

  list.forEach(function (a) {
    const w = M.partWeights(exOf(a.exId));
    const volShare = a.sets / totalSets;
    Object.keys(w).forEach(function (p) {
      if (!parts[p]) parts[p] = { part: p, sum: 0, wsum: 0 };
      const ww = w[p] * volShare;
      parts[p].sum += (a.index - 1) * ww;
      parts[p].wsum += ww;
    });
  });

  const out = Object.keys(parts).map(function (p) {
    const x = parts[p];
    return {
      part: p,
      name: (require('../data/exercises').PART_CN || {})[p] || p,
      delta: x.wsum > 0 ? round(x.sum / x.wsum * 100, 1) : 0
    };
  });
  out.sort(function (a, b) { return b.delta - a.delta; });
  return out;
}

/* ================= 高光时刻（§7.4） ================= */

/**
 * 从数据里找值得讲的事件。每种都带「之前多少 / 现在多少 / 隔了多久」。
 * 这里只产出事实，文案（讲成什么故事）交给页面。
 */
function highlights(rows, opts) {
  const o = opts || {};
  const noise = M.PARAMS.noise;
  const out = [];

  actions(rows, o).forEach(function (a) {
    const items = series(rows, a.exId, o).items;
    if (!items.length) return;

    // 1) 第一次 / 第 N 次（坚持）
    const first = items[0];
    out.push({
      kind: 'first',
      exId: a.exId, cn: a.cn, date: first.date, exposure: 1,
      value: first.value, unit: first.unit
    });
    M.EXPOSURE_MILESTONES.forEach(function (n) {
      if (a.exposures === n || items.length === n) {
        const it = items[n - 1];
        out.push({
          kind: 'streak',
          exId: a.exId, cn: a.cn, date: it.date, exposure: n,
          value: n, unit: '次', detail: { times: n }
        });
      }
    });

    // 2) 新纪录 + 突破停滞
    let best = -Infinity;
    let flat = 0;
    items.forEach(function (it, i) {
      const prevBest = best;
      if (it.value > best * (1 + noise) || i === 0) {
        if (i > 0 && it.value > best) {
          out.push({
            kind: flat >= M.PARAMS.stallAfter ? 'breakthrough' : 'record',
            exId: a.exId, cn: a.cn, date: it.date, exposure: it.exposure,
            value: it.value, unit: it.unit,
            detail: { prev: prevBest, prevDate: items[i - 1].date, gapDays: it.gapDays, flat: flat, bestSet: it.best }
          });
          flat = 0;
        }
        best = Math.max(best, it.value);
      } else {
        if (it.value > best) best = it.value;
        flat++;
      }
    });

    // 3) 整数关口：第一次跨过有象征意义的数值（每个关口各出一次）
    //    第一次训练本身就报「第一次」，不再额外报一堆关口；一天跨多个关口只报最高的那个
    const unitKey = a.model === 'e1rm' ? 'kg' : (a.model === 'duration' ? 'sec' : (a.model === 'reps' ? 'reps' : ''));
    const marks = M.MILESTONES[unitKey] || [];
    if (marks.length) {
      const hit = {};
      items.forEach(function (it, i) {
        const raw = a.model === 'e1rm' ? it.best.weight : it.best.reps;
        const crossed = marks.filter(function (m) { return raw >= m && !hit[m]; });
        crossed.forEach(function (m) { hit[m] = true; });
        if (i === 0 || !crossed.length) return;
        const top = crossed[crossed.length - 1];
        out.push({
          kind: 'milestone',
          exId: a.exId, cn: a.cn, date: it.date, exposure: it.exposure,
          value: top, unit: UNIT_CN[unitKey] || unitKey,
          detail: { mark: top, actual: raw, reps: it.best.reps, crossed: crossed }
        });
      });
    }

    // 4) 进阶阶梯升级
    if (a.model === 'ladder') {
      items.forEach(function (it, i) {
        if (i === 0) return;
        const prev = items[i - 1];
        if (it.level > prev.level) {
          out.push({
            kind: 'upgrade',
            exId: a.exId, cn: a.cn, date: it.date, exposure: it.exposure,
            value: it.level, unit: '级',
            detail: { from: prev.level, to: it.level, fromCn: prev.exCn, toCn: it.exCn }
          });
        }
      });
    }
  });

  out.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return dedupeAndRank(out);
}

/**
 * 高光排序 + 去重：
 *   - 同一天同一动作同一个值，只留「更重要」的那条（突破停滞 > 升级 > 整数关口 > 坚持 > 新纪录 > 第一次）
 *   - 首屏要优先看到有故事的，而不是一串「新纪录」
 */
const HIGHLIGHT_RANK = { breakthrough: 1, upgrade: 2, milestone: 3, streak: 4, record: 5, first: 6 };

function dedupeAndRank(list) {
  const seen = {};
  const kept = [];
  // 先按重要度排，重要的先占位
  list.slice().sort(function (a, b) {
    return (HIGHLIGHT_RANK[a.kind] || 9) - (HIGHLIGHT_RANK[b.kind] || 9);
  }).forEach(function (h) {
    const key = h.exId + '|' + h.date + '|' + Math.round(h.value * 100);
    if (seen[key]) return;
    seen[key] = true;
    kept.push(h);
  });
  // 再按「重要度 → 日期新到旧」排
  kept.sort(function (a, b) {
    const ra = HIGHLIGHT_RANK[a.kind] || 9;
    const rb = HIGHLIGHT_RANK[b.kind] || 9;
    if (ra !== rb) return ra - rb;
    return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
  });
  return kept;
}

/** 某一天的高光（战报用，S2） */
function todayHighlights(rows, date) {
  const day = date || D.today();
  return highlights(rows).filter(function (h) { return h.date === day; });
}

/** 一段时间里进步最大的动作（§7.4「最大进步」） */
function bestGain(rows, from, to) {
  const list = actions(rows, { from: from, to: to }).filter(function (a) { return a.ok; });
  if (!list.length) return null;
  const top = list.reduce(function (a, b) { return b.index >= a.index ? b : a; });
  return {
    kind: 'bestGain',
    exId: top.exId, cn: top.cn, date: top.lastDate,
    value: top.index,
    detail: { pct: round((top.index - 1) * 100, 1), from: from || '', to: to || '' }
  };
}

/* ================= 数据质量（§10） ================= */

/**
 * 输入校验：重量超过该动作历史最好 1.5 倍时，录入当场要确认（防 50 输成 500）。
 * @returns {{suspect:boolean, max:number, ratio:number}}
 */
function suspectWeight(rows, exId, weight) {
  const w = num(weight);
  const hist = workSets(rows).filter(function (s) { return s.exId === exId && num(s.weight) > 0; });
  if (!hist.length || !(w > 0)) return { suspect: false, max: 0, ratio: 0 };
  const max = hist.reduce(function (a, s) { return Math.max(a, num(s.weight)); }, 0);
  return { suspect: w > max * 1.5, max: max, ratio: max > 0 ? round(w / max, 2) : 0 };
}

/* ================= 给页面/战报用的快捷入口 ================= */

/** 懒加载 db：避免 db → progress → db 成环，也让纯函数可以在测试里脱离 db 跑 */
function dbMod() { return require('./db'); }

/** 体重查表：取训练那天之前最近一次记录的体重（§8.3，减重不能改写过去的负荷） */
function bodyweightAtFactory() {
  let list = null;
  return function (date) {
    if (!list) {
      try { list = dbMod().metricSeries('weight') || []; } catch (e) { list = []; }
    }
    let v = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].date <= date && list[i].value > 0) v = list[i].value;
    }
    return v;
  };
}

function optsWithBw(opts) {
  const o = Object.assign({}, opts || {});
  if (!o.bodyweightAt) o.bodyweightAt = bodyweightAtFactory();
  return o;
}

function seriesOf(exId, opts) { return series(dbMod().allSets(), exId, optsWithBw(opts)); }
function trendOf(exId, opts) { return trend(dbMod().allSets(), exId, optsWithBw(opts)); }
function actionsNow(opts) { return actions(dbMod().allSets(), optsWithBw(opts)); }
function overallNow(opts) { return overall(dbMod().allSets(), optsWithBw(opts)); }
function highlightsNow(opts) { return highlights(dbMod().allSets(), optsWithBw(opts)); }
function todayNow(date) { return todayHighlights(dbMod().allSets(), date); }
function suspectNow(exId, weight) { return suspectWeight(dbMod().allSets(), exId, weight); }

module.exports = {
  // 常量 / 参数
  MODEL_CN, UNIT_CN,
  // 纯函数（测试和页面都能直接用）
  loadOf, e1rm, pickBest, confidenceOf, weekKey,
  series, trend, actions, overall, partProgress,
  highlights, todayHighlights, bestGain, suspectWeight,
  // 快捷入口（内部懒加载 db）
  seriesOf, trendOf, actionsNow, overallNow, highlightsNow, todayNow, suspectNow,
  bodyweightAtFactory
};
