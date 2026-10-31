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

// 老数据没有 updatedAt：给一个足够早的时刻，和服务端（别的设备）的版本冲突时让对方赢
const LEGACY_STAMP = '2000-01-01T00:00:00.000Z';

let cache = null;        // { months: {'2026-10': [row]}, live: [row] | null }
let wcache = null;       // { '2026': [workout] }
let dirtyCache = null;
let lastStamp = 0;
const listeners = [];

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
    wx.setStorageSync(K_PREFIX + m, list);
  } else {
    wx.removeStorageSync(K_PREFIX + m);
    delete c.months[m];
  }
  wx.setStorageSync(K_MONTHS, Object.keys(c.months).sort());
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
  if (dirtyChanged) wx.setStorageSync(K_DIRTY, dirty);
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
    wx.setStorageSync(K_W_PREFIX + y, list);
  } else {
    wx.removeStorageSync(K_W_PREFIX + y);
    delete wcache[y];
  }
  wx.setStorageSync(K_W_YEARS, Object.keys(wcache).sort());
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
  if (dirtyChanged) wx.setStorageSync(K_DIRTY, d);
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
  wx.removeStorageSync(K_DIRTY);
  cache = { months: {}, live: null };
  wcache = {};
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
  wx.setStorageSync(K_DIRTY, d);
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
  wx.setStorageSync(K_DIRTY, d);
}

/**
 * 取一批待上传的行（组记录 + 训练合计不超过 limit）。
 * @returns {{ rows: Array, workouts: Array, sent: {id: updatedAt} }}
 */
function dirtyBatch(limit) {
  const d = dirtyMap();
  const outS = [];
  const outW = [];
  const sent = {};
  const ids = Object.keys(d);
  for (let i = 0; i < ids.length && outS.length + outW.length < limit; i++) {
    const id = ids[i];
    const isW = id.indexOf(W_PREFIX) === 0;
    const r = isW ? workout(id.slice(W_PREFIX.length)) : get(id);
    if (!r) { delete d[id]; continue; }          // 行已经不在了（被物理删掉），队列里的残留
    (isW ? outW : outS).push(r);
    sent[id] = d[id];
  }
  return { rows: outS, workouts: outW, sent: sent };
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
  Object.keys(sent).forEach(function (id) {
    if (d[id] !== sent[id]) return;
    delete d[id];
    if (id.indexOf(W_PREFIX) === 0) {
      const w = workout(id.slice(W_PREFIX.length));
      if (w && !w.done) dropW.push(w.date);
      return;
    }
    const r = get(id);
    if (r && !r.done) drop.push(id);
  });
  (rejectedIds || []).forEach(function (id) { delete d[id]; });
  wx.setStorageSync(K_DIRTY, d);
  if (drop.length) remove(drop);
  if (dropW.length) removeWorkouts(dropW);
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
  months.forEach(function (m) {
    const list = Object.keys(byMonth[m]).map(function (k) { return byMonth[m][k]; });
    wx.setStorageSync(K_PREFIX + m, list);
  });
  const existing = wx.getStorageSync(K_MONTHS) || [];
  const all = {};
  existing.concat(months).forEach(function (m) { all[m] = true; });
  wx.setStorageSync(K_MONTHS, Object.keys(all).sort());
  wx.removeStorageSync(K_LEGACY);    // 最后才删老 key：中途崩了下次还能重来
}

/** 测试用：丢掉内存缓存，强制从存储重读 */
function reset() {
  cache = null;
  wcache = null;
  dirtyCache = null;
}

module.exports = {
  LEGACY_STAMP,
  stamp, rowId,
  rows, live, get,
  putLocal, putMany, remove,
  workout, workouts, putWorkoutLocal, putWorkouts, removeWorkouts,
  removeAll,
  dirtyMap, markAllDirty, dirtyBatch, ack, applyRemote, applyRemoteWorkouts, pendingCount, onDirty,
  rejectedIds,
  reset
};
