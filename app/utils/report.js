/**
 * 线上错误上报（上线加固）
 *
 * 解决的问题：`app.js` 以前只有 onLaunch / onShow，线上白屏、JS 报错、跳到不存在的页面
 * 全都**没有任何线索** —— 用户只会说「打不开」。
 *
 * 三条硬约束，和同步层同一套价值观：
 *   1. **绝不影响用户**：任何异常都吞掉，不弹窗、不阻塞、不改页面行为；
 *   2. **绝不刷屏**：同一条错误 60 秒内只报一次，一次启动最多 20 条；
 *   3. **没连后端就静默**：纯本地模式（config 地址留空）直接不动，一行请求都不发。
 *
 * 依赖只有 config.js（叶子模块），不 require db / sync —— 否则 app.js 启动链路会成环。
 * 测试里把 wx.request 换掉即可，见 test-sync.js 的「客户端错误上报」一节。
 */

const CFG = require('./config');

const MAX_PER_SESSION = 20;       // 一次启动最多上报条数
const DEDUPE_MS = 60 * 1000;      // 同一条错误在这个窗口内只报一次
const MAX_FIELD = 400;            // 单字段截断（服务端还有一道 500 / 2000 的上限）

let sent = 0;
let lastSeen = {};                // key → 上次上报的毫秒时间
let sid = '';

/** 本次启动的会话 id：服务端靠它把一串错误串成一次会话 */
function sessionId() {
  if (sid) return sid;
  sid = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  return sid;
}

function clip(s) {
  if (s === undefined || s === null) return '';
  const str = String(s);
  return str.length > MAX_FIELD ? str.slice(0, MAX_FIELD) : str;
}

/** 当前页面路由（不依赖 getCurrentPages 一定存在） */
function currentPage() {
  try {
    const pages = getCurrentPages();
    const top = pages && pages[pages.length - 1];
    return (top && top.route) || '';
  } catch (e) {
    return '';
  }
}

function envVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || '';
  } catch (e) {
    return '';
  }
}

/** 测试用：清空节流状态，让同一批断言可以重跑 */
function reset() {
  sent = 0;
  lastSeen = {};
  sid = '';
}

/**
 * 报一条错误。
 * @param {string} kind  onError | onUnhandledRejection | onPageNotFound | 自定义
 * @param {object} info  任意字段，只取 msg / stack / page / path
 * @returns {boolean} 是否真的发出去了（测试用；生产不关心返回值）
 */
function send(kind, info) {
  try {
    if (!CFG.syncEnabled()) return false;          // 纯本地模式：不打扰任何人
    if (sent >= MAX_PER_SESSION) return false;
    if (!wx || typeof wx.request !== 'function') return false;

    const i = info || {};
    const msg = clip(i.msg || i.message || i.errMsg || i);
    const stack = clip(i.stack);
    const key = kind + '|' + msg;
    const now = Date.now();
    if (lastSeen[key] && now - lastSeen[key] < DEDUPE_MS) return false;
    lastSeen[key] = now;
    sent++;

    wx.request({
      url: CFG.apiBase() + '/client-error',
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      timeout: 5000,
      data: {
        kind: clip(kind),
        page: clip(i.page || currentPage()),
        path: clip(i.path),
        msg: msg,
        stack: stack,
        sid: sessionId(),
        env: envVersion(),
        at: new Date().toISOString()
      },
      // 上报本身就是「尽量试试」，失败就算了：不重试、不缓存、不弹窗
      success: function () { },
      fail: function () { }
    });
    return true;
  } catch (e) {
    return false;
  }
}

/** App.onError 用：小程序 JS 未捕获异常 */
function crash(err) {
  return send('onError', {
    msg: (err && (err.message || err.errMsg)) || String(err || ''),
    stack: err && err.stack
  });
}

/** App.onUnhandledRejection 用：没人 catch 的 Promise */
function rejection(res) {
  const r = (res && res.reason) || {};
  return send('onUnhandledRejection', {
    msg: r.message || String(res && res.reason || ''),
    stack: r.stack
  });
}

module.exports = { send, crash, rejection, reset, sessionId };
