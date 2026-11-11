/**
 * 训练数据的本地存储 + 待上传队列
 *
 * 存储键：
 *   lj.sets.months    ['2026-09', '2026-10']   有组记录的月份
 *   lj.sets.2026-10   [row, ...]               这个月的组记录（含墓碑 done:false）
 *   lj.workouts.years ['2026']                 有「一次训练」的年份
 *   lj.workouts.2026  [workout, ...]           这一年的训练（一天一行，含墓碑）
 *   lj.sync.dirty     { id: updatedAt }        改过还没上传的行；训练的 id 是 'w:YYYY-MM-DD'
 *
 * 为什么按月分：微信本地存储单 key 上限 1MB、总共 10MB。全部记录塞一个 key，
 * 一周练 3 次大约 31 个月写满；按月分开，每月约 45KB，10MB 够存十几年。
 * 顺带每次存一组只重写当月那一小块，不用把全部历史重新序列化一遍。
 * 训练一年最多 366 行（约 40KB），按年分就够了。
 *
 * 内存缓存：db.js 渲染一页要读好几遍全部记录，每次都从存储反序列化太浪费。
 * 所有写入都经过本文件，所以缓存不会和存储不一致。
 *
 * 只有 db.js 和同步逻辑应该引用这个文件，页面不要直接用。
 */

const K_MONTHS = 'lj.sets.months';
const K_PREFIX = 'lj.sets.';
const K_LEGACY = 'lj.sets';            // 老版本：全部记录一个 key
const K_DIRTY = 'lj.sync.dirty';
const K_W_YEARS = 'lj.workouts.years';
const K_W_PREFIX = 'lj.workouts.';
const W_PREFIX = 'w:';                 // 待上传队列里训练的 id 前缀
// 身体指标：一天一个值，按月分（一个月最多 9 种 × 31 天 ≈ 28KB）
const K_M_MONTHS = 'lj.metrics.months';
const K_M_PREFIX = 'lj.metrics.';
const M_PREFIX = 'm:';                 // 待上传队列里指标的 id 前缀
const X_PREFIX = 'x:';                 // 待上传队列里自建动作的 id 前缀

// 自建动作的存储与合并规则在 catalog 里（它是动作数据的唯一入口），
// 这里只负责「它在待上传队列里怎么排队」。依赖方向 catalog → storage 不能反。
const CAT = require('./catalog');
const safeStorage = require('./safeStorage');

// 老数据没有 updatedAt：给一个足够早的时刻，和服务端（别的设备）的版本冲突时让对方赢
const LEGACY_STAMP = '2000-01-01T00:00:00.000Z';

let cache = null;        // { months: {'2026-10': [row]}, live: [row] | null }
let wcache = null;       // { '2026': [workout] }
let mcache = null;       // { '2026-11': [metric] }
let dirtyCache = null;
let lastStamp = 0;
const listeners = [];

/* ---------------- 写入保护（本地空间满） ---------------- */

/**
 * 存储写满时 wx.setStorageSync 会直接抛异常（单 key 1MB / 总共 10MB）。
 * 真正兜住它的是 safeStorage（storage 和 catalog 共用），这里只负责本模块的额外一步：
 * **写失败就丢掉内存缓存**，让下一次读回到磁盘真相
 * —— 宁可「刚记的那组没显示」，也不做「看着有、重进就没」。
 *
 * 注意：写失败后缓存整体失效，所以 persist 返回 false 时调用方必须**立刻返回**，
 * 不要继续往索引 key（lj.sets.months 之类）里写半截数据，否则索引和分片对不上。
 */
function dropCaches() {
  cache = null;
  wcache = null;
  mcache = null;
  dirtyCache = null;
}

function persist(key, val) {
  if (safeStorage.set(key, val)) return true;
  dropCaches();
  return false;
}


/* ---------------- 时间戳 ---------------- */

/**
 * 本地写入时刻，严格递增。
 * 同一毫秒内连改两次必须拿到不同的值，否则「上传途中又改了」判断不出来，
 * 第二次修改会被当成已上传而丢掉。
 */
function stamp() {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp).toISOString();
}

/* ---------------- 组记录：读 ---------------- */

function rowId(r) {
  return r.date + '-' + r.exId + '-' + r.setNo;
}

function monthOf(date) {
  return String(date).slice(0, 7);
}

function load() {
  if (cache) return cache;
  cache = { months: {}, live: null };

  migrateLegacy();

  const months = wx.getStorageSync(K_MONTHS) || [];
  months.forEach(function (m) {
    const rows = wx.getStorageSync(K_PREFIX + m);
    cache.months[m] = Array.isArray(rows) ? rows : [];
  });
  return cache;
}

/** 全部记录，含墓碑（同步用） */
function rows() {
  const c = load();
  const out = [];
  Object.keys(c.months).sort().forEach(function (m) {
    c.months[m].forEach(function (r) { out.push(r); });
  });
  return out;
}

/** 有效记录（不含墓碑）。返回的是缓存，调用方只读不改 */
function live() {
  const c = load();
  if (!c.live) c.live = rows().filter(function (r) { return r.done; });
  return c.live;
}

function get(id) {
  const list = load().months[monthOf(id)] || [];
  return list.filter(function (r) { return r.id === id; })[0] || null;
}

/* ---------------- 组记录：写 ---------------- */

function writeMonth(m) {
  const c = cache;
  const list = c.months[m] || [];
  if (list.length) {
    // 写失败：缓存已整体失效，立刻返回，别把索引写成和分片对不上的样子
    if (!persist(K_PREFIX + m, list)) return;
  } else {
    wx.removeStorageSync(K_PREFIX + m);
    delete c.months[m];
  }
  persist(K_MONTHS, Object.keys(c.months).sort());
  c.live = null;
}

function upsertInMemory(row) {
  const c = load();
  const m = monthOf(row.date);
  if (!c.months[m]) c.months[m] = [];
  const list = c.months[m];
  const idx = list.findIndex(function (r) { return r.id === row.id; });
  if (idx >= 0) list[idx] = row; else list.push(row);
  return m;
}

function removeInMemory(id) {
  const c = load();
  const m = monthOf(id);
  const list = c.months[m];
  if (!list) return null;
  const idx = list.findIndex(function (r) { return r.id === id; });
  if (idx < 0) return null;
  list.splice(idx, 1);
  return m;
}

/**
 * 本地产生的一次写入：盖时间戳；同步打开时进待上传队列。
 * @param {object} row 不需要带 id / updatedAt
 * @param {boolean} track 是否进待上传队列
 */
function putLocal(row, track) {
  const r = Object.assign({}, row);
  r.id = rowId(r);
  r.updatedAt = stamp();
  writeMonth(upsertInMemory(r));
  if (track) markDirty(r.id, r.updatedAt);
  return r;
}

/**
 * 批量写入「不是用户刚做的」行：示例数据、从服务端拉下来的行。
 * 不改时间戳、不进上传队列。每个月只落一次盘。
 */
function putMany(list, opts) {
  const skipExisting = opts && opts.skipExisting;
  const touched = {};
  list.forEach(function (row) {
    const r = Object.assign({}, row);
    r.id = rowId(r);
    if (skipExisting && get(r.id)) return;
    touched[upsertInMemory(r)] = true;
  });
  Object.keys(touched).forEach(writeMonth);
}

/** 物理删除（不留墓碑） */
function remove(ids) {
  const touched = {};
  const dirty = dirtyMap();
  let dirtyChanged = false;
  ids.forEach(function (id) {
    const m = removeInMemory(id);
    if (m) touched[m] = true;
    if (dirty[id]) { delete dirty[id]; dirtyChanged = true; }
  });
  Object.keys(touched).forEach(writeMonth);
  if (dirtyChanged) persist(K_DIRTY, dirty);
}

/* ---------------- 一次训练 ---------------- */

function wid(date) {
  return W_PREFIX + date;
}

function yearOf(date) {
  return String(date).slice(0, 4);
}

function wload() {
  if (wcache) return wcache;
  wcache = {};
  (wx.getStorageSync(K_W_YEARS) || []).forEach(function (y) {
    const list = wx.getStorageSync(K_W_PREFIX + y);
    wcache[y] = Array.isArray(list) ? list : [];
  });
  return wcache;
}

function wwrite(y) {
  const list = wcache[y] || [];
  if (list.length) {
    if (!persist(K_W_PREFIX + y, list)) return;
  } else {
    wx.removeStorageSync(K_W_PREFIX + y);
    delete wcache[y];
  }
  persist(K_W_YEARS, Object.keys(wcache).sort());
}

function wupsert(row) {
  const c = wload();
  const y = yearOf(row.date);
  if (!c[y]) c[y] = [];
  const list = c[y];
  const idx = list.findIndex(function (w) { return w.date === row.date; });
  if (idx >= 0) list[idx] = row; else list.push(row);
  return y;
}

/** 某天的训练（含墓碑），没有返回 null */
function workout(date) {
  const list = wload()[yearOf(date)] || [];
  return list.filter(function (w) { return w.date === date; })[0] || null;
}

/** 全部训练（含墓碑），按日期升序 */
function workouts() {
  const c = wload();
  const out = [];
  Object.keys(c).forEach(function (y) {
    c[y].forEach(function (w) { out.push(w); });
  });
  return out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

/** 本地产生的训练改动：盖时间戳；同步打开时进待上传队列 */
function putWorkoutLocal(row, track) {
  const r = Object.assign({}, row);
  r.updatedAt = stamp();
  wwrite(wupsert(r));
  if (track) markDirty(wid(r.date), r.updatedAt);
  return r;
}

/** 批量写入（示例数据、服务端下发）：不改时间戳、不进队列 */
function putWorkouts(list) {
  const touched = {};
  list.forEach(function (row) { touched[wupsert(Object.assign({}, row))] = true; });
  Object.keys(touched).forEach(wwrite);
}

function removeWorkouts(dates) {
  const c = wload();
  const touched = {};
  const d = dirtyMap();
  let dirtyChanged = false;
  dates.forEach(function (date) {
    const y = yearOf(date);
    const list = c[y];
    if (list) {
      const idx = list.findIndex(function (w) { return w.date === date; });
      if (idx >= 0) { list.splice(idx, 1); touched[y] = true; }
    }
    if (d[wid(date)]) { delete d[wid(date)]; dirtyChanged = true; }
  });
  Object.keys(touched).forEach(wwrite);
  if (dirtyChanged) persist(K_DIRTY, d);
}

/* ---------------- 身体指标 ---------------- */

function monthOfDate(date) { return String(date).slice(0, 7); }
function metricKey(r) { return r.kind + '|' + r.date; }
function mid(r) { return M_PREFIX + metricKey(r); }

function mload() {
  if (mcache) return mcache;
  mcache = {};
  const months = wx.getStorageSync(K_M_MONTHS) || [];
  months.forEach(function (m) {
    const rows = wx.getStorageSync(K_M_PREFIX + m);
    mcache[m] = Array.isArray(rows) ? rows : [];
  });
  return mcache;
}

function mwrite(m) {
  const list = mcache[m] || [];
  if (list.length) {
    if (!persist(K_M_PREFIX + m, list)) return;
  } else {
    wx.removeStorageSync(K_M_PREFIX + m);
    delete mcache[m];
  }
  persist(K_M_MONTHS, Object.keys(mcache).sort());
}

function mupsert(row) {
  const c = mload();
  const m = monthOfDate(row.date);
  if (!c[m]) c[m] = [];
  const list = c[m];
  const k = metricKey(row);
  const idx = list.findIndex(function (r) { return metricKey(r) === k; });
  if (idx >= 0) list[idx] = row; else list.push(row);
  return m;
}

/** 某天某种指标（含墓碑），没有返回 null */
function metric(kind, date) {
  const list = mload()[monthOfDate(date)] || [];
  return list.filter(function (r) { return r.kind === kind && r.date === date; })[0] || null;
}

/** 全部指标（含墓碑），按日期升序、同日按 kind 排 */
function metrics() {
  const c = mload();
  const out = [];
  Object.keys(c).sort().forEach(function (m) {
    c[m].forEach(function (r) { out.push(r); });
  });
  return out.sort(function (a, b) {
    if (a.date === b.date) return a.kind < b.kind ? -1 : 1;
    return a.date < b.date ? -1 : 1;
  });
}

/** 本地产生的指标改动：盖时间戳；同步打开时进待上传队列 */
function putMetricLocal(row, track) {
  const r = Object.assign({}, row);
  r.updatedAt = stamp();
  mwrite(mupsert(r));
  if (track) markDirty(mid(r), r.updatedAt);
  return r;
}

/** 批量写入（服务端下发）：不改时间戳、不进队列 */
function putMetrics(list) {
  const touched = {};
  list.forEach(function (row) { touched[mupsert(Object.assign({}, row))] = true; });
  Object.keys(touched).forEach(mwrite);
}

/** 物理删除，keys 是 [{kind,date}] */
function removeMetrics(keys) {
  const c = mload();
  const touched = {};
  const d = dirtyMap();
  let dirtyChanged = false;
  keys.forEach(function (k) {
    const m = monthOfDate(k.date);
    const list = c[m];
    if (list) {
      const idx = list.findIndex(function (r) { return r.kind === k.kind && r.date === k.date; });
      if (idx >= 0) { list.splice(idx, 1); touched[m] = true; }
    }
    const id = M_PREFIX + k.kind + '|' + k.date;
    if (d[id]) { delete d[id]; dirtyChanged = true; }
  });
  Object.keys(touched).forEach(mwrite);
  if (dirtyChanged) persist(K_DIRTY, d);
}

/** 应用服务端下发的指标：本地有未上传改动的先不动；墓碑直接删 */
function applyRemoteMetrics(list) {
  const d = dirtyMap();
  const puts = [];
  const dels = [];
  list.forEach(function (r) {
    if (d[mid(r)]) return;
    if (r.done) puts.push(r);
    else if (metric(r.kind, r.date)) dels.push({ kind: r.kind, date: r.date });
  });
  if (puts.length) putMetrics(puts);
  if (dels.length) removeMetrics(dels);
  return puts.length + dels.length;
}

/* ---------------- 全部清空 ---------------- */

/** 组记录、训练、待上传队列全部清掉 */
function removeAll() {
  const c = load();
  Object.keys(c.months).forEach(function (m) { wx.removeStorageSync(K_PREFIX + m); });
  wx.removeStorageSync(K_MONTHS);
  const w = wload();
  Object.keys(w).forEach(function (y) { wx.removeStorageSync(K_W_PREFIX + y); });
  wx.removeStorageSync(K_W_YEARS);
  const mm = mload();
  Object.keys(mm).forEach(function (m) { wx.removeStorageSync(K_M_PREFIX + m); });
  wx.removeStorageSync(K_M_MONTHS);
  wx.removeStorageSync(K_DIRTY);
  cache = { months: {}, live: null };
  wcache = {};
  mcache = {};
  dirtyCache = {};
}

/* ---------------- 待上传队列 ---------------- */

function dirtyMap() {
  if (!dirtyCache) dirtyCache = wx.getStorageSync(K_DIRTY) || {};
  return dirtyCache;
}

function markDirty(id, updatedAt) {
  const d = dirtyMap();
  d[id] = updatedAt;
  persist(K_DIRTY, d);
  listeners.slice().forEach(function (fn) {
    try { fn(); } catch (e) { /* 单个监听器出错不影响写入 */ }
  });
}

/** 有本地改动时通知（同步模块用它来「改完 2 秒后上传」） */
function onDirty(fn) {
  listeners.push(fn);
}

/** 第一次接上后端：把本地全部真实数据排进上传队列（这就是「先全量上传」那一步） */
function markAllDirty() {
  const d = dirtyMap();
  rows().forEach(function (r) {
    if (r.demo) return;                 // 示例数据不上传
    if (!d[r.id]) d[r.id] = r.updatedAt || LEGACY_STAMP;
  });
  workouts().forEach(function (w) {
    if (w.demo) return;
    if (!d[wid(w.date)]) d[wid(w.date)] = w.updatedAt || LEGACY_STAMP;
  });
  metrics().forEach(function (r) {
    if (r.demo) return;
    if (!d[mid(r)]) d[mid(r)] = r.updatedAt || LEGACY_STAMP;
  });
  // 自建动作（含墓碑）：墓碑也要传，否则删除不会同步到别的设备
  CAT.rawCustom().forEach(function (e) {
    if (!d[X_PREFIX + e.exId]) d[X_PREFIX + e.exId] = e.updatedAt || LEGACY_STAMP;
  });
  persist(K_DIRTY, d);
}

/**
 * 取一批待上传的行（组记录 + 训练 + 指标 + 自建动作合计不超过 limit）。
 *
 * 自建动作排在**最前面**：最多 30 条，如果攒在 500 组记录后面，
 * 重度用户（积压几百组）永远传不上动作，而记录里引用的正是这些动作 id。
 *
 * @returns {{ rows: Array, workouts: Array, metrics: Array, exercises: Array, sent: {id: updatedAt} }}
 */
function dirtyBatch(limit) {
  const d = dirtyMap();
  const outS = [];
  const outW = [];
  const outM = [];
  const outX = [];
  const sent = {};
  const ids = Object.keys(d);
  // x: 优先（稳定排序：其余保持原有顺序）
  ids.sort(function (a, b) {
    const ax = a.indexOf(X_PREFIX) === 0 ? 0 : 1;
    const bx = b.indexOf(X_PREFIX) === 0 ? 0 : 1;
    return ax - bx;
  });
  const total = function () { return outS.length + outW.length + outM.length + outX.length; };
  for (let i = 0; i < ids.length && total() < limit; i++) {
    const id = ids[i];
    const isW = id.indexOf(W_PREFIX) === 0;
    const isM = id.indexOf(M_PREFIX) === 0;
    const isX = id.indexOf(X_PREFIX) === 0;
    let r;
    if (isW) {
      r = workout(id.slice(W_PREFIX.length));
    } else if (isM) {
      const parts = id.slice(M_PREFIX.length).split('|');
      r = metric(parts[0], parts[1]);
    } else if (isX) {
      const exId = id.slice(X_PREFIX.length);
      r = CAT.rawCustom().filter(function (e) { return e.exId === exId; })[0];
    } else {
      r = get(id);
    }
    if (!r) { delete d[id]; continue; }          // 行已经不在了（被物理删掉），队列里的残留
    if (isW) outW.push(r);
    else if (isM) outM.push(r);
    else if (isX) outX.push(r);
    else outS.push(r);
    sent[id] = d[id];
  }
  return { rows: outS, workouts: outW, metrics: outM, exercises: outX, sent: sent };
}

/**
 * 服务端确认收到。只清「发出去之后没再改过」的行——
 * 上传途中用户又改了一次，那条的 updatedAt 已经变了，必须留在队列里下次再传。
 * 已确认的墓碑顺手物理删掉：服务端已经有了，本地留着没用。
 */
function ack(sent, rejectedIds) {
  const d = dirtyMap();
  const drop = [];
  const dropW = [];
  const dropM = [];
  const dropX = [];
  Object.keys(sent).forEach(function (id) {
    if (d[id] !== sent[id]) return;
    delete d[id];
    if (id.indexOf(W_PREFIX) === 0) {
      const w = workout(id.slice(W_PREFIX.length));
      if (w && !w.done) dropW.push(w.date);
      return;
    }
    if (id.indexOf(M_PREFIX) === 0) {
      const parts = id.slice(M_PREFIX.length).split('|');
      const r = metric(parts[0], parts[1]);
      if (r && !r.done) dropM.push({ kind: r.kind, date: r.date });
      return;
    }
    if (id.indexOf(X_PREFIX) === 0) {
      const exId = id.slice(X_PREFIX.length);
      const r = CAT.rawCustom().filter(function (e) { return e.exId === exId; })[0];
      if (r && r.done === false) dropX.push(exId);   // 墓碑服务端已经收了，本地不用留
      return;
    }
    const r = get(id);
    if (r && !r.done) drop.push(id);
  });
  (rejectedIds || []).forEach(function (id) { delete d[id]; });
  persist(K_DIRTY, d);
  if (drop.length) remove(drop);
  if (dropW.length) removeWorkouts(dropW);
  if (dropM.length) removeMetrics(dropM);
  dropX.forEach(function (exId) { CAT.dropCustom(exId); });
}

/**
 * 应用服务端下发的组记录。
 * 本地还有没上传的改动 → 先不动它（等它上传后由服务端裁决，赢家会在下次拉取时回来）。
 * 墓碑 → 本地直接删。
 * @returns {number} 实际改动的行数
 */
function applyRemote(list) {
  const d = dirtyMap();
  const puts = [];
  const dels = [];
  list.forEach(function (r) {
    const id = rowId(r);
    if (d[id]) return;
    if (r.done) puts.push(r); else if (get(id)) dels.push(id);
  });
  if (puts.length) putMany(puts);
  if (dels.length) remove(dels);
  return puts.length + dels.length;
}

/** 应用服务端下发的训练。规则同上；服务端版本是按字段合并后的结果，直接采用 */
function applyRemoteWorkouts(list) {
  const d = dirtyMap();
  const puts = [];
  const dels = [];
  list.forEach(function (w) {
    if (d[wid(w.date)]) return;
    if (w.done) puts.push(w); else if (workout(w.date)) dels.push(w.date);
  });
  if (puts.length) putWorkouts(puts);
  if (dels.length) removeWorkouts(dels);
  return puts.length + dels.length;
}

function pendingCount() {
  return Object.keys(dirtyMap()).length;
}

/* ---------------- 导入（换手机恢复用） ---------------- */

/**
 * 时间戳比较：ISO 字符串直接按字典序比就够了（同一时区、同一格式）。
 * 缺时间戳的当成最旧 —— 这样「没有 updatedAt 的脏数据」永远不会盖掉本机真实记录。
 */
function cmpTime(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function blankCount() { return { added: 0, updated: 0, skipped: 0 }; }

function tally(out, o, dirty, id, updatedAt) {
  if (o.dryRun) return;
  if (o.track) dirty[id] = updatedAt;
}

/**
 * 导入一批组记录。**只加不删**，同 id（同一天同一动作同一组）比 updatedAt，新的赢。
 * dryRun=true 只算账不落盘 —— 页面先拿它弹确认框（「将恢复 N 组」）。
 * track=true 时同时排进上传队列：先纯本地用、之后开云端，恢复出来的历史也要能上云。
 * @returns {{added:number, updated:number, skipped:number}}
 */
function importRows(list, opts) {
  const o = opts || {};
  const out = blankCount();
  const touched = {};
  const dirty = o.dryRun ? null : dirtyMap();
  (list || []).forEach(function (row) {
    const r = Object.assign({}, row);
    r.id = rowId(r);
    if (r.done === false) { out.skipped++; return; }   // 墓碑不导
    r.done = true;
    const prev = get(r.id);
    if (prev && cmpTime(prev.updatedAt, r.updatedAt) >= 0) { out.skipped++; return; }
    if (prev) out.updated++; else out.added++;
    if (o.dryRun) return;
    touched[upsertInMemory(r)] = true;
    tally(out, o, dirty, r.id, r.updatedAt);
  });
  if (!o.dryRun) {
    Object.keys(touched).forEach(writeMonth);
    if (o.track) persist(K_DIRTY, dirty);
  }
  return out;
}

/** 导入一次训练（一天一行），规则同 importRows */
function importWorkouts(list, opts) {
  const o = opts || {};
  const out = blankCount();
  const touched = {};
  const dirty = o.dryRun ? null : dirtyMap();
  (list || []).forEach(function (row) {
    const r = Object.assign({}, row);
    if (!r.date) { out.skipped++; return; }
    if (r.done === false) { out.skipped++; return; }
    r.done = true;
    const prev = workout(r.date);
    if (prev && cmpTime(prev.updatedAt, r.updatedAt) >= 0) { out.skipped++; return; }
    if (prev) out.updated++; else out.added++;
    if (o.dryRun) return;
    touched[wupsert(r)] = true;
    tally(out, o, dirty, wid(r.date), r.updatedAt);
  });
  if (!o.dryRun) {
    Object.keys(touched).forEach(wwrite);
    if (o.track) persist(K_DIRTY, dirty);
  }
  return out;
}

/** 导入身体指标（kind + date 一行），规则同上 */
function importMetrics(list, opts) {
  const o = opts || {};
  const out = blankCount();
  const touched = {};
  const dirty = o.dryRun ? null : dirtyMap();
  (list || []).forEach(function (row) {
    const r = Object.assign({}, row);
    if (!r.kind || !r.date) { out.skipped++; return; }
    if (r.done === false) { out.skipped++; return; }
    r.done = true;
    const prev = metric(r.kind, r.date);
    if (prev && cmpTime(prev.updatedAt, r.updatedAt) >= 0) { out.skipped++; return; }
    if (prev) out.updated++; else out.added++;
    if (o.dryRun) return;
    touched[mupsert(r)] = true;
    tally(out, o, dirty, mid(r), r.updatedAt);
  });
  if (!o.dryRun) {
    Object.keys(touched).forEach(mwrite);
    if (o.track) persist(K_DIRTY, dirty);
  }
  return out;
}

/** 导入自建动作（只认 u- 前缀，官方动作是内置的，不需要导） */
function importExercises(list, opts) {
  const o = opts || {};
  const out = blankCount();
  const dirty = o.dryRun ? null : dirtyMap();
  const PARTS = { chest: 1, shoulders: 1, arms: 1, back: 1, legs: 1, core: 1 };
  (list || []).forEach(function (e) {
    if (!e || !e.exId || String(e.exId).indexOf('u-') !== 0) { out.skipped++; return; }
    // 部位是六大类之一才有意义：部位错了会污染「换动作」候选和部位统计
    if (!PARTS[e.part]) { out.skipped++; return; }
    const prev = CAT.rawCustom().filter(function (x) { return x.exId === e.exId; })[0];
    if (prev && cmpTime(prev.updatedAt, e.updatedAt) >= 0) { out.skipped++; return; }
    if (prev) out.updated++; else out.added++;
    if (o.dryRun) return;
    CAT.putCustom({
      exId: String(e.exId), cn: String(e.cn || ''), part: String(e.part || ''),
      place: e.place === 'home' ? 'home' : 'gym',
      unit: (e.unit === 'bw' || e.unit === 'sec') ? e.unit : 'kg',
      tips: String(e.tips || ''), done: true,
      updatedAt: String(e.updatedAt || ''), rev: 0
    });
    tally(out, o, dirty, X_PREFIX + e.exId, String(e.updatedAt || ''));
  });
  if (!o.dryRun && o.track) persist(K_DIRTY, dirty);
  return out;
}

/**
 * 应用服务端下发的自建动作。
 * 「本地有未上传改动就先不动」的判断复用待上传队列，规则和其他三类一致。
 */
function applyRemoteExercises(list) {
  return CAT.applyRemoteCustom(list, function (id) {
    return !!dirtyMap()[id];
  });
}

/**
 * 把服务端返回的 rejected 映射成待上传队列里的 id。
 * id 的生成规则只在本文件里维护（组记录 = date-exId-setNo，训练 = "w:日期"），
 * 所以映射也放在这里，免得同步层再复制一份规则。
 * config 被拒不出队（配置只有一份，留着下次再传）。
 */
function rejectedIds(batch, rejected) {
  const out = [];
  const b = batch || {};
  (rejected || []).forEach(function (r) {
    if (r.kind === 'set' && b.rows && b.rows[r.index]) {
      out.push(rowId(b.rows[r.index]));
    } else if (r.kind === 'workout' && b.workouts && b.workouts[r.index]) {
      out.push(wid(b.workouts[r.index].date));
    } else if (r.kind === 'metric' && b.metrics && b.metrics[r.index]) {
      out.push(mid(b.metrics[r.index]));
    } else if (r.kind === 'customExercise' && b.exercises && b.exercises[r.index]) {
      const exId = b.exercises[r.index].exId;
      out.push(X_PREFIX + exId);
      // 留在本地但标红：删掉的话用户永远不知道这条哪里错了（动作库.md §7.4）
      CAT.setSyncError(exId, r.reason);
    }
  });
  return out;
}

/* ---------------- 老版本升级 ---------------- */

/**
 * lj.sets（一个 key 一个大数组）→ 按月分 key。
 * 老版本示例数据的 id 组号从 0 起，和真实记录的 id 规则对不上 —— 以此认出示例数据，
 * 打上 demo 标记，以后不会被当成真实记录上传。
 */
function migrateLegacy() {
  const old = wx.getStorageSync(K_LEGACY);
  if (!Array.isArray(old)) {
    if (old !== '') wx.removeStorageSync(K_LEGACY);
    return;
  }

  const byMonth = {};
  old.forEach(function (row) {
    if (!row || !row.date) return;
    const r = Object.assign({}, row);
    const id = rowId(r);
    if (r.id && r.id !== id) r.demo = true;
    r.id = id;
    if (!r.updatedAt) r.updatedAt = LEGACY_STAMP;
    if (r.done === undefined) r.done = true;
    const m = monthOf(r.date);
    if (!byMonth[m]) byMonth[m] = {};
    byMonth[m][id] = r;                  // 同 id 后者覆盖，和老版本 saveSet 的语义一致
  });

  const months = Object.keys(byMonth).sort();
  let allWritten = true;
  months.forEach(function (m) {
    const list = Object.keys(byMonth[m]).map(function (k) { return byMonth[m][k]; });
    if (!persist(K_PREFIX + m, list)) allWritten = false;
  });
  // 只要有一个分片没写进去，就保留老 key 下次重来（不然老数据就没了）
  if (!allWritten) return;

  const existing = wx.getStorageSync(K_MONTHS) || [];
  const all = {};
  existing.concat(months).forEach(function (m) { all[m] = true; });
  if (!persist(K_MONTHS, Object.keys(all).sort())) return;   // 索引没写成，老 key 也留着
  wx.removeStorageSync(K_LEGACY);    // 最后才删老 key：中途崩了下次还能重来
}

/** 测试用：丢掉内存缓存，强制从存储重读 */
function reset() {
  cache = null;
  wcache = null;
  mcache = null;
  dirtyCache = null;
}

module.exports = {
  LEGACY_STAMP,
  stamp, rowId,
  rows, live, get,
  putLocal, putMany, remove,
  workout, workouts, putWorkoutLocal, putWorkouts, removeWorkouts,
  metric, metrics, putMetricLocal, putMetrics, removeMetrics, applyRemoteMetrics,
  removeAll,
  dirtyMap, markDirty, markAllDirty, dirtyBatch, ack, applyRemote, applyRemoteWorkouts, applyRemoteExercises,
  importRows, importWorkouts, importMetrics, importExercises,
  pendingCount, onDirty,
  rejectedIds,
  reset
};
