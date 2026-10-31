/**
 * 同步调度（C3）
 *
 * 职责只有四件：**认证、调度、分批、搬运**。
 * 数据怎么存、什么该传、传回来怎么应用，全在 db.js / storage.js 里 —— 这一层不碰业务语义，
 * 也不做任何冲突裁决（LWW 由服务端裁）。
 *
 * 硬约束：**失败不能打扰用户**。所有错误只记日志 + 退避，绝不弹 toast。
 * 后端整个挂掉时，小程序照常记录、照常看统计（开发计划 P3 验收标准）。
 *
 * 只归这里管的存储键：
 *   lj.auth        { token, expiresAt }
 *   lj.sync.cursor 上次拉到的服务端版本号
 *
 * 只打两个接口：POST /login、POST /sync。
 */

const CFG = require('./config');
const db = require('./db');
const store = require('../store/index');

const K_AUTH = 'lj.auth';
const K_CURSOR = 'lj.sync.cursor';

const BATCH_ROWS = 500;      // 服务端单批上限（sets + workouts + metrics 合计）
const MAX_ROUNDS = 20;       // 单次触发最多循环轮数，防止 hasMore 异常时打转
const DEBOUNCE_MS = 2000;    // 本地改动合并成一次上传
const IDLE_POLL_MS = 30000;  // 还有积压时每 30 秒再试
const BACKOFF_MIN = 5000;    // 首次失败 5 秒后重试
const BACKOFF_MAX = 300000;  // 封顶 5 分钟
const REQUEST_TIMEOUT = 10000;

/* ---------------- 传输层（可替换） ---------------- */

/** 生产：wx.request 包成 Promise */
function wxTransport(opt) {
  return new Promise(function (resolve, reject) {
    wx.request({
      url: opt.url,
      method: opt.method || 'GET',
      header: opt.header || {},
      data: opt.data,
      timeout: REQUEST_TIMEOUT,
      success: function (res) {
        resolve({ statusCode: res.statusCode, data: res.data, header: res.header || {} });
      },
      fail: function (err) {
        reject(new Error('网络错误: ' + ((err && err.errMsg) || 'unknown')));
      }
    });
  });
}

let transport = wxTransport;

/**
 * 测试用：换成内存版假服务端。
 * 没有这个口子，C6 的「两台设备互相同步」只能连真后端，在 node 里跑不了。
 */
function setTransport(fn) {
  transport = fn || wxTransport;
}

/* ---------------- 状态 ---------------- */

let running = false;   // 单飞：同一时刻只跑一个
let again = false;     // 跑的过程中又有改动 → 结束后再跑一轮
let listenersBound = false;
let debounceTimer = null;
let pollTimer = null;
let retryTimer = null;
let retryDelay = 0;
let lastError = '';
let lastSyncAt = '';

function log(msg) {
  // 只记日志，绝不弹窗
  try { console.warn('[sync] ' + msg); } catch (e) { /* 忽略 */ }
}

function clearTimers() {
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

/* ---------------- 认证 ---------------- */

function auth() {
  const a = wx.getStorageSync(K_AUTH);
  return a && a.token ? a : null;
}

function saveAuth(token, expiresAt) {
  wx.setStorageSync(K_AUTH, { token: token, expiresAt: expiresAt || '' });
}

function clearAuth() {
  wx.removeStorageSync(K_AUTH);
}

function wxLogin() {
  return new Promise(function (resolve, reject) {
    wx.login({
      success: function (r) {
        if (r && r.code) resolve(r.code);
        else reject(new Error('wx.login 没返回 code'));
      },
      fail: function (e) {
        reject(new Error('wx.login 失败: ' + ((e && e.errMsg) || 'unknown')));
      }
    });
  });
}

/* ---------------- HTTP ---------------- */

function call(path, body, token) {
  const header = { 'Content-Type': 'application/json' };
  if (token) header.Authorization = 'Bearer ' + token;

  return transport({
    url: CFG.apiBase() + path,
    method: 'POST',
    header: header,
    data: body
  }).then(function (res) {
    if (res.statusCode === 200) return res.data || {};

    const payload = res.data || {};
    const code = (payload.error && payload.error.code) || '';
    const err = new Error('HTTP ' + res.statusCode + (code ? ' ' + code : ''));
    err.status = res.statusCode;
    err.code = code;
    err.retryAfter = res.header && (res.header['Retry-After'] || res.header['retry-after']);
    throw err;
  });
}

function login() {
  return wxLogin()
    .then(function (code) { return call('/login', { code: code }); })
    .then(function (out) {
      if (!out.token) throw new Error('login 没返回 token');
      saveAuth(out.token, out.expiresAt);
      return out.token;
    });
}

function ensureToken() {
  const a = auth();
  return a ? Promise.resolve(a.token) : login();
}

/* ---------------- 游标 ---------------- */

function getCursor() {
  const c = Number(wx.getStorageSync(K_CURSOR));
  return isFinite(c) && c > 0 ? c : 0;
}

function setCursor(c) {
  if (typeof c === 'number' && isFinite(c)) wx.setStorageSync(K_CURSOR, c);
}

/* ---------------- 一次同步 ---------------- */

/**
 * 先推后拉，循环到「队列空且 hasMore=false」。
 *
 * 401 → 清 token、重登一次、重试同一批（服务端幂等，整批重传安全）。
 * 被服务端拒绝的行要出队，否则一条坏数据会让上传队列永远卡住。
 */
function syncOnce(token) {
  let rounds = 0;
  let appliedRows = 0;
  let pushedRows = 0;

  function step() {
    if (rounds >= MAX_ROUNDS) {
      log('单次同步到 ' + MAX_ROUNDS + ' 轮上限，剩下的下次继续');
      return Promise.resolve({ rounds: rounds, applied: appliedRows, pushed: pushedRows, capped: true });
    }
    rounds++;

    const batch = db.syncPullBatch(BATCH_ROWS);
    const body = {
      cursor: getCursor(),
      sets: batch.rows,
      workouts: batch.workouts,
      metrics: [],               // 身体指标模块（P5）还没做
      config: batch.config       // 没改动时是 null
    };
    pushedRows += batch.rows.length + batch.workouts.length + (batch.config ? 1 : 0);

    return call('/sync', body, token)
      .catch(function (err) {
        if (err.status !== 401) throw err;
        clearAuth();
        return login().then(function (fresh) {
          token = fresh;
          return call('/sync', body, token);
        });
      })
      .then(function (out) {
        const rejected = out.rejected || [];
        if (rejected.length) {
          log('服务端拒绝 ' + rejected.length + ' 行：' + JSON.stringify(rejected.slice(0, 3)));
        }

        db.syncAck(batch, db.rejectedIds(batch, rejected));
        appliedRows += db.syncApply({
          sets: out.sets,
          workouts: out.workouts,
          config: out.config
        });
        setCursor(out.cursor);

        // 有变化才通知页面（页面自己决定要不要重画）
        if (appliedRows > 0) store.touchSets();

        if (!out.hasMore && db.syncPending() === 0) {
          return { rounds: rounds, applied: appliedRows, pushed: pushedRows, cursor: out.cursor };
        }
        return step();
      });
  }

  return step();
}

/* ---------------- 调度 ---------------- */

function scheduleRetry(err) {
  const ra = err && err.retryAfter ? Number(err.retryAfter) * 1000 : 0;
  if (ra > 0) {
    retryDelay = Math.min(ra, BACKOFF_MAX);                       // 429：听服务端的
  } else {
    retryDelay = retryDelay ? Math.min(retryDelay * 2, BACKOFF_MAX) : BACKOFF_MIN;
  }

  const jitter = 0.5 + Math.random();                             // 0.5–1.5，避免所有客户端同时回来
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(function () { retryTimer = null; run(); }, Math.round(retryDelay * jitter));
}

function scheduleIdlePoll() {
  if (!db.syncPending()) return;                                  // 没积压就不空转
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(function () { pollTimer = null; run(); }, IDLE_POLL_MS);
}

/** 本地有改动：合并成 2 秒后的一次上传 */
function debounce() {
  if (!CFG.syncEnabled()) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(function () { debounceTimer = null; run(); }, DEBOUNCE_MS);
}

/**
 * 注册「本地改动 → 2 秒后上传」。只注册一次。
 *
 * init() 和 run() 都会调它：引导没走完时 init() 会直接跳过，但用户走完引导后
 * App.onLaunch 不会重跑——靠 kick() → run() 把监听补上，否则之后手动记的组
 * 永远等不到「改动后 2 秒上传」。
 */
function bindOnce() {
  if (listenersBound) return;
  listenersBound = true;
  db.onDirty(debounce);      // 组记录 / 训练 / 配置 三类改动都会走到这里
}

/** 跑一次同步（单飞；跑的时候又来的请求会在结束后补一轮） */
function run() {
  if (!CFG.syncEnabled()) return Promise.resolve({ skipped: 'off' });
  if (!db.hasOnboarded()) return Promise.resolve({ skipped: 'onboard' });

  bindOnce();

  if (running) {
    again = true;
    return Promise.resolve({ skipped: 'running' });
  }

  running = true;
  clearTimers();

  return ensureToken()
    .then(function (token) { return syncOnce(token); })
    .then(function (r) {
      lastSyncAt = new Date().toISOString();
      lastError = '';
      retryDelay = 0;
      return r;
    })
    .catch(function (err) {
      lastError = (err && err.message) || String(err);
      log('同步失败：' + lastError);
      scheduleRetry(err);
      return { error: lastError };
    })
    .then(function (r) {
      running = false;
      if (again) {
        again = false;
        return run();
      }
      scheduleIdlePoll();
      return r;
    });
}

/** app.js 的 onLaunch 调一次 */
function init() {
  if (!CFG.syncEnabled()) {
    log('未配置后端地址，纯本地模式');
    return Promise.resolve({ skipped: 'off' });
  }
  if (!db.hasOnboarded()) return Promise.resolve({ skipped: 'onboard' });

  return run();      // run() 内部会 bindOnce()
}

/** 页面的 onShow 或手动触发 */
function kick() {
  return run();
}

/** 停掉所有定时器（测试收尾、或用户关闭同步） */
function stop() {
  clearTimers();
  again = false;
  retryDelay = 0;
}

function status() {
  return {
    enabled: CFG.syncEnabled(),
    running: running,
    pending: db.syncPending(),
    cursor: getCursor(),
    lastSyncAt: lastSyncAt,
    lastError: lastError,
    retryDelay: retryDelay
  };
}

module.exports = {
  init, kick, stop, status, setTransport,
  /* 测试用 */
  __cursor: { get: getCursor, set: setCursor }
};
