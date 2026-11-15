/**
 * 战报分享快照：把「这一天战报页要展示的东西」打包进分享链接。
 *
 * 为什么需要它：力见是纯本地应用，分享卡片默认只带走一张缩略图，
 * 好友点开后读到的是他自己手机里的数据（往往是空的），分享就失去了意义。
 * 快照只含页面展示用的汇总字段（不含每组明细），随链接走，好友端只读渲染。
 *
 * 编码：UTF-8 → base64url，外面由微信/调用方再做 url-encode。
 * 自实现而不用 btoa/Buffer：小程序基础库没有全局 btoa，要保证和 node 测试同构。
 *
 * 版本：v 字段留版本位，以后结构变了旧链接 decode 返回 null，页面自然回退本地模式。
 */

const VER = 1;

/** 整条 token 的长度上限。微信对页面 query 无公开硬限制，社区经验 1KB 内稳妥 */
const MAX_TOKEN = 900;

const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/* ---------------- base64url（UTF-8 安全） ---------------- */

function b64urlEncode(str) {
  // unescape(encodeURIComponent(...))：JS 字符串 → UTF-8 字节序列（binary string）
  const bin = unescape(encodeURIComponent(str));
  let out = '';
  let i = 0;
  for (; i + 2 < bin.length; i += 3) {
    const b0 = bin.charCodeAt(i);
    const b1 = bin.charCodeAt(i + 1);
    const b2 = bin.charCodeAt(i + 2);
    out += B64C[b0 >> 2];
    out += B64C[((b0 & 3) << 4) | (b1 >> 4)];
    out += B64C[((b1 & 15) << 2) | (b2 >> 6)];
    out += B64C[b2 & 63];
  }
  const rest = bin.length - i;
  if (rest === 1) {
    const b0 = bin.charCodeAt(i);
    out += B64C[b0 >> 2] + B64C[(b0 & 3) << 4];
  } else if (rest === 2) {
    const b0 = bin.charCodeAt(i);
    const b1 = bin.charCodeAt(i + 1);
    out += B64C[b0 >> 2] + B64C[((b0 & 3) << 4) | (b1 >> 4)] + B64C[(b1 & 15) << 2];
  }
  return out;   // base64url 无 padding
}

function b64urlDecode(s) {
  const map = {};
  for (let i = 0; i < B64C.length; i++) map[B64C.charAt(i)] = i;
  // 兼容标准 base64 的 +/=（理论上不会出现，解码端宽松一点）
  map['+'] = map['-'];
  map['/'] = map['_'];

  let bin = '';
  for (let i = 0; i < s.length; i += 4) {
    const c0 = map[s.charAt(i)];
    const c1 = map[s.charAt(i + 1)];
    const c2 = map[s.charAt(i + 2)];
    const c3 = map[s.charAt(i + 3)];
    if (c0 === undefined || c1 === undefined) return null;
    bin += String.fromCharCode((c0 << 2) | (c1 >> 4));
    if (c2 !== undefined) bin += String.fromCharCode(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 !== undefined) bin += String.fromCharCode(((c2 & 3) << 6) | c3);
  }
  try {
    return decodeURIComponent(escape(bin));
  } catch (e) {
    return null;   // 非法 UTF-8 序列
  }
}

/* ---------------- 字段消毒：好友端永远不信任链接里的内容 ---------------- */

function finiteNum(v, def, max) {
  const n = Number(v);
  if (!isFinite(n)) return def;
  const r = Math.round(n * 100) / 100;
  if (r < 0) return def;
  if (max !== undefined && r > max) return max;
  return r;
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

function normParts(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length && out.length < 6; i++) {
    const it = list[i] || {};
    const name = str(it.name, 8);
    const pct = finiteNum(it.pct, NaN, 100);
    if (!name || !isFinite(pct)) continue;
    out.push({ name: name, pct: pct });
  }
  return out;
}

function normPrs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (let i = 0; i < list.length && out.length < 5; i++) {
    const it = list[i] || {};
    const cn = str(it.cn, 12);
    const weight = finiteNum(it.weight, NaN, 1000);
    if (!cn || !isFinite(weight)) continue;
    out.push({
      cn: cn,
      weight: weight,
      delta: finiteNum(it.delta, 0, 1000)
    });
  }
  return out;
}

/**
 * 打包。
 * @param {object} r    db.todayReport() 的返回（页面 data.r 同构）
 * @param {object} texts { dateText, head, comment, dayWord }
 * @returns {string} token；数据异常或裁剪后仍超长时返回 ''（调用方回退到旧分享路径）
 */
function encode(r, texts) {
  if (!r || typeof r !== 'object') return '';
  const t = texts || {};
  const unit = ['kg', 'bw', 'sec'].indexOf(r.unit) >= 0 ? r.unit : 'kg';

  let snap = {
    v: VER,
    d: str(r.date, 10),
    p: str(r.planName, 20),
    s: finiteNum(r.sets, 0, 999),
    ps: finiteNum(r.plannedSets, 0, 999),
    e: finiteNum(r.exercises, 0, 99),
    u: unit,
    t: finiteNum(r.ton, 0, 9999),
    rp: finiteNum(r.reps, 0, 99999),
    sc: finiteNum(r.seconds, 0, 99999),
    pr: normPrs(r.prs),
    pt: normParts(r.parts),
    dt: str(t.dateText, 30),
    h: str(t.head, 30),
    c: str(t.comment, 80),
    dw: str(t.dayWord, 4)
  };

  let token = b64urlEncode(JSON.stringify(snap));

  // 超长兜底：先砍部位（6→3→0），再砍 PR（5→2→0），再压文案
  const partSteps = [3, 0];
  for (let i = 0; i < partSteps.length && token.length > MAX_TOKEN; i++) {
    snap.pt = snap.pt.slice(0, partSteps[i]);
    token = b64urlEncode(JSON.stringify(snap));
  }
  const prSteps = [2, 0];
  for (let i = 0; i < prSteps.length && token.length > MAX_TOKEN; i++) {
    snap.pr = snap.pr.slice(0, prSteps[i]);
    token = b64urlEncode(JSON.stringify(snap));
  }
  if (token.length > MAX_TOKEN) {
    snap.c = '';
    snap.h = str(snap.h, 16);
    snap.p = str(snap.p, 10);
    token = b64urlEncode(JSON.stringify(snap));
  }

  return token.length <= MAX_TOKEN ? token : '';
}

/**
 * 解包。任何异常都返回 null（页面回退本地模式，绝不白屏）。
 * @returns {{r: object, date: string, dateText: string, head: string, comment: string, dayWord: string}|null}
 */
function decode(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN * 2) return null;
  const json = b64urlDecode(token);
  if (!json) return null;

  let s;
  try {
    s = JSON.parse(json);
  } catch (e) {
    return null;
  }
  if (!s || typeof s !== 'object' || s.v !== VER) return null;

  const unit = ['kg', 'bw', 'sec'].indexOf(s.u) >= 0 ? s.u : 'kg';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s.d) ? s.d : '';

  return {
    date: date,
    dateText: str(s.dt, 30),
    head: str(s.h, 30) || '训练战报',
    comment: str(s.c, 80),
    dayWord: str(s.dw, 4) || '那天',
    r: {
      planName: str(s.p, 20) || '自由训练',
      sets: finiteNum(s.s, 0, 999),
      plannedSets: finiteNum(s.ps, 0, 999),
      exercises: finiteNum(s.e, 0, 99),
      unit: unit,
      ton: finiteNum(s.t, 0, 9999),
      reps: finiteNum(s.rp, 0, 99999),
      seconds: finiteNum(s.sc, 0, 99999),
      parts: normParts(s.pt),
      // 页面 PR 行还用到 exId 作 wx:key，快照里没有稳定 id，用 cn 兜底
      prs: normPrs(s.pr).map(function (p, i) {
        return { exId: 's' + i, cn: p.cn, weight: p.weight, delta: p.delta };
      })
    }
  };
}

module.exports = { encode: encode, decode: decode, VER: VER, MAX_TOKEN: MAX_TOKEN };
