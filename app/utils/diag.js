/**
 * 本地诊断日志（不联网也要能查问题）
 *
 * 为什么需要：产品定位是「轻量 · 无需登录 · 首版纯本地」，这样一来
 * `utils/report.js` 的错误上报**没有服务端可发** —— 线上白屏、某个页面崩了，
 * 手上依然是零线索。用户只会说「打不开」，你没有任何东西可查。
 *
 * 所以把错误留在本机：最近 40 条，环形覆盖（写满丢最旧的），随「我的 → 诊断信息」
 * 一键复制。用户只要把这段贴给你，就能定位到页面和报错原文。
 *
 * 依赖只有 safeStorage（叶子模块），保证能在启动最早期被 require：
 * app.js → report.js → diag.js 这条链不能把 db / catalog 拖进来。
 */

const safeStorage = require('./safeStorage');

const K = 'lj.diag';
const MAX = 40;          // 只留最近 40 条
const FIELD = 200;       // 单字段截断（页面/文件名不长，报错原文留前面够了）

function clip(s, max) {
  if (s === undefined || s === null) return '';
  const str = String(s).replace(/\s+/g, ' ').trim();
  return str.length > max ? str.slice(0, max) : str;
}

function read() {
  try {
    const list = wx.getStorageSync(K);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/** 记一条。kind：onError | onUnhandledRejection | onPageNotFound | 自定义 */
function push(kind, msg, page) {
  try {
    const list = read();
    list.push({
      at: new Date().toISOString(),
      kind: clip(kind, 24),
      page: clip(page, 60),
      msg: clip(msg, FIELD)
    });
    while (list.length > MAX) list.shift();
    return safeStorage.set(K, list);
  } catch (e) {
    return false;      // 记日志本身永远不能把事搞大
  }
}

function list() { return read(); }

function clear() {
  try { wx.removeStorageSync(K); } catch (e) { /* 忽略 */ }
}

/** '09:38' —— 诊断信息里时间只用来排序，不需要日期 */
function hhmm(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

/**
 * 拼成一段可复制的纯文本。
 * @param {string[]} extra 调用方补的行（比如「本机 3120 组 / 练过 96 天」）
 */
function text(extra) {
  const lines = ['练界 · 诊断信息'];

  try {
    const env = wx.getAccountInfoSync().miniProgram.envVersion || 'unknown';
    const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
    lines.push('环境：' + env + ' · SDK ' + (sys.SDKVersion || '?') + ' · ' + (sys.platform || '?'));
  } catch (e) {
    lines.push('环境：未知');
  }

  try {
    const info = wx.getStorageInfoSync ? wx.getStorageInfoSync() : null;
    if (info) {
      lines.push('存储：' + Math.round((info.currentSize || 0) / 102.4) / 10 + 'MB / ' +
        Math.round((info.limitSize || 0) / 1024) + 'MB（' + (info.keys || []).length + ' 个 key）');
    }
  } catch (e) { /* 拿不到用量就算了 */ }

  (extra || []).forEach(function (l) { if (l) lines.push(l); });

  const errs = read();
  if (!errs.length) {
    lines.push('最近错误：无');
  } else {
    lines.push('最近错误：' + errs.length + ' 条（最新的在最后）');
    errs.forEach(function (e) {
      lines.push('  ' + hhmm(e.at) + ' [' + e.kind + '] ' + (e.page ? e.page + '：' : '') + e.msg);
    });
  }

  lines.push('时间：' + new Date().toISOString());
  return lines.join('\n');
}

module.exports = { push, list, clear, text, key: K };
