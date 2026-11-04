/**
 * 动作库 —— 全项目唯一的动作数据源
 *
 * 为什么要有这个文件：
 *   以前动作只来自 data/exercises.js（打在小程序包里的静态数组）。接上服务端动作库之后，
 *   动作有三个来源：**服务端清单**（lj.catalog）、**用户自建**（lj.customEx）、**包内快照**（exercises.js）。
 *   下游有十几处要查动作（记录页、战报、换动作、方案中心、选动作面板……），
 *   如果每处自己拼来源，一定会有人漏掉自建动作，界面上就会冒出 `u-m8f2k9ab-a7x2` 这种 id。
 *
 * 依赖方向（不能反）：
 *   exercises.js  →  catalog.js  →  db.js / plan.js / pages
 *   catalog 只读 wx storage 和包内静态数据，**不 require db.js**——db.js 已经 require 了 plan.js，
 *   反过来 require 会成环，页面起来时拿到的是半截 exports。
 */

const EX = require('../data/exercises');

const K_CATALOG = 'lj.catalog';          // { rev, fetchedAt, list:[…] } 官方清单（整份覆盖）
const K_DETAIL = 'lj.catalog.detail.';   // + id → { steps, imgDetail, fetchedAt }
const K_CUSTOM = 'lj.customEx';          // 自建动作数组（含墓碑）

const DETAIL_TTL = 7 * 24 * 3600 * 1000; // 详情缓存 7 天（清单没有逐行版本，过期重拉）
const MAX_CUSTOM = 30;                   // 自建动作上限，只由客户端把关

let catalogCache = null;
let customCache = null;
let detailLoader = null;                 // 由 app.js 注入 sync.request，避免 catalog → sync → db → catalog 成环
const listeners = [];

/* ---------------- 读 ---------------- */

function readCatalog() {
  if (catalogCache) return catalogCache;
  const v = wx.getStorageSync(K_CATALOG);
  catalogCache = (v && Array.isArray(v.list)) ? v : null;
  return catalogCache;
}

function readCustom() {
  if (customCache) return customCache;
  const v = wx.getStorageSync(K_CUSTOM);
  customCache = Array.isArray(v) ? v : [];
  return customCache;
}

/** 清掉内存缓存（storage 被外部改写之后调用） */
function invalidate() {
  catalogCache = null;
  customCache = null;
}

/** 官方清单：有服务端下发的就用它，没有就用包里那份快照。retired 在这里过滤掉 */
function list() {
  const cat = readCatalog();
  const src = (cat && cat.list.length) ? cat.list : EX.EXERCISES;
  return src.filter(function (e) { return !e.retired; });
}

/** 自建动作（过滤墓碑）。带 custom:true，方便下游区分来源 */
function custom() {
  return readCustom()
    .filter(function (e) { return e.done !== false; })
    .map(function (e) {
      return {
        id: e.exId, cn: e.cn, en: '', part: e.part, place: e.place,
        unit: e.unit, tips: e.tips || '', custom: true,
        // 被服务端拒绝过的行要把原因带到界面上（「我的动作」里标红），不能静默消失
        syncError: e.syncError || ''
      };
    });
}

/** 服务端拒绝这一行时，把原因记在本地行上（不删行——删了用户永远不知道哪里错了） */
function setSyncError(exId, reason) {
  const all = readCustom().slice();
  const i = all.findIndex(function (e) { return e.exId === exId; });
  if (i < 0) return;
  all[i] = Object.assign({}, all[i], { syncError: reason || '服务端拒绝' });
  wx.setStorageSync(K_CUSTOM, all);
  customCache = all;
  emit();
}

/** 官方 + 自建。查不到返回 null（下游自己决定兜底文案） */
function find(id) {
  if (!id) return null;
  const list0 = list();
  for (let i = 0; i < list0.length; i++) {
    if (list0[i].id === id) return list0[i];
  }
  const c = custom();
  for (let i = 0; i < c.length; i++) {
    if (c[i].id === id) return c[i];
  }
  return null;
}

/**
 * 换动作候选：同部位 + 同场所的官方动作，加上全部自建动作。
 *
 * 为什么自建动作不做场所过滤：用户的 place 只有 gym/home 两个值，而自建动作可能两处都能做；
 * 更实际的原因是「我是自己建的动作，你凭什么不让我选」。所以显式放行，不靠 place 取巧
 * （写成 place:'all' 会被下游的等值比较永久过滤掉）。
 */
function candidates(exId) {
  const ex = find(exId);
  if (!ex) return [];
  const out = [];
  list().forEach(function (e) {
    if (e.id !== exId && e.part === ex.part && e.place === ex.place) out.push(e);
  });
  custom().forEach(function (e) {
    if (e.id !== exId && e.part === ex.part) out.push(e);
  });
  return out;
}

/** 全部可选的（选动作面板用）：官方在前按部位，自建置顶由页面决定。
 *  place 传 'all' 或不传 = 不过滤（和 db.pickableExercises 的约定一致，别在这里搞两套语义）。 */
function pickable(place) {
  const all = !place || place === 'all';
  const out = [];
  custom().forEach(function (e) { out.push(e); });          // 我的动作整组置顶
  list().forEach(function (e) {
    if (all || e.place === place) out.push(e);
  });
  return out;
}

/* ---------------- 详情（异步，缓存优先） ---------------- */

/** 注入详情加载器（app.js 里：catalog.setDetailLoader(sync.request)） */
function setDetailLoader(fn) { detailLoader = fn; }

/**
 * 详情：{ steps:[], imgDetail:'' }。
 * 缓存命中且没过期 → 同步返回；否则异步拉，失败就返回 null（页面只显示列表字段，不弹窗、不阻塞）。
 */
function detail(id) {
  const key = K_DETAIL + id;
  const hit = wx.getStorageSync(key);
  if (hit && hit.fetchedAt && (Date.now() - hit.fetchedAt) < DETAIL_TTL) {
    return Promise.resolve(hit);
  }
  if (!detailLoader) return Promise.resolve(null);
  return detailLoader('/exercises/' + encodeURIComponent(id), { method: 'GET' })
    .then(function (out) {
      const rec = {
        steps: (out && Array.isArray(out.steps)) ? out.steps : [],
        imgDetail: (out && out.imgDetail) || '',
        fetchedAt: Date.now()
      };
      wx.setStorageSync(key, rec);
      pruneDetail();
      return rec;
    })
    .catch(function () {
      return null;   // 拿不到大图就不显示，页面主体照常可用
    });
}

/** 详情缓存 LRU：最多留 50 条，按 fetchedAt 老的先删 */
function pruneDetail() {
  let keys = [];
  try {
    keys = (wx.getStorageInfoSync().keys || []).filter(function (k) {
      return k.indexOf(K_DETAIL) === 0;
    });
  } catch (e) { return; }
  if (keys.length <= 50) return;
  const rows = keys.map(function (k) {
    const v = wx.getStorageSync(k) || {};
    return { k: k, at: v.fetchedAt || 0 };
  }).sort(function (a, b) { return a.at - b.at; });
  rows.slice(0, keys.length - 50).forEach(function (r) { wx.removeStorageSync(r.k); });
}

/* ---------------- 写 ---------------- */

/**
 * 整份写入官方清单（服务端下发后调用）。
 * rev 只在**真正写进去之后**才更新：先写 rev 却拉失败，会导致「rev 已前进、清单永远旧」。
 */
function applyCatalog(rev, arr) {
  wx.setStorageSync(K_CATALOG, {
    rev: rev,
    fetchedAt: Date.now(),
    list: Array.isArray(arr) ? arr : []
  });
  invalidate();
  emit();
}

/** 清单的本地 rev（没有就是 0） */
function catalogRev() {
  const c = readCatalog();
  return (c && c.rev) || 0;
}

/** 本地写入一个自建动作（含墓碑）。不负责上传队列——那是 storage 的事 */
function putCustom(rec) {
  const all = readCustom().slice();
  const i = all.findIndex(function (e) { return e.exId === rec.exId; });
  if (i >= 0) all[i] = rec; else all.push(rec);
  wx.setStorageSync(K_CUSTOM, all);
  customCache = all;
  emit();
  return rec;
}

/** 应用服务端下发的自建动作：本地有未上传改动的先跳过；墓碑直接删掉本地行 */
function applyRemoteCustom(arr, isPending) {
  const all = readCustom().slice();
  let n = 0;
  (arr || []).forEach(function (r) {
    if (isPending && isPending('x:' + r.exId)) return;
    const i = all.findIndex(function (e) { return e.exId === r.exId; });
    if (r.done === false) {
      if (i >= 0) { all.splice(i, 1); n++; }
      return;
    }
    const rec = {
      exId: r.exId, cn: r.cn, part: r.part, place: r.place,
      unit: r.unit, tips: r.tips || '', done: true,
      updatedAt: r.updatedAt, rev: r.rev || 0
    };
    if (i >= 0) all[i] = rec; else all.push(rec);
    n++;
  });
  wx.setStorageSync(K_CUSTOM, all);
  customCache = all;
  if (n) emit();
  return n;
}

/** 自建动作的原始记录（含墓碑），同步层要拿它上传 */
function rawCustom() {
  return readCustom();
}

/** 本地删掉一条自建动作（服务端确认墓碑之后） */
function dropCustom(exId) {
  const all = readCustom().filter(function (e) { return e.exId !== exId; });
  wx.setStorageSync(K_CUSTOM, all);
  customCache = all;
  emit();
}

/** 还能不能再建一个（墓碑不占名额） */
function canAddCustom() {
  return custom().length < MAX_CUSTOM;
}

/* ---------------- 变更通知 ---------------- */

function onChange(fn) { if (listeners.indexOf(fn) < 0) listeners.push(fn); }

function emit() {
  listeners.forEach(function (fn) {
    try { fn(); } catch (e) { console.error('[catalog] 监听器出错', e); }
  });
}

/** 清空（resetAll 用）：清单、详情缓存、自建动作 */
function reset() {
  wx.removeStorageSync(K_CATALOG);
  wx.removeStorageSync(K_CUSTOM);
  try {
    (wx.getStorageInfoSync().keys || []).forEach(function (k) {
      if (k.indexOf(K_DETAIL) === 0) wx.removeStorageSync(k);
    });
  } catch (e) { /* 拿不到 keys 就算了，反正下次整份覆盖 */ }
  invalidate();
  emit();
}

module.exports = {
  list, custom, rawCustom, dropCustom, find, candidates, pickable,
  detail, setDetailLoader, applyCatalog, catalogRev,
  putCustom, applyRemoteCustom, setSyncError, canAddCustom,
  onChange, invalidate, reset,
  /* 只给测试用 */
  __const: { K_CATALOG: K_CATALOG, K_CUSTOM: K_CUSTOM, K_DETAIL: K_DETAIL, MAX_CUSTOM: MAX_CUSTOM }
};
