/**
 * 战报分享图（1080×864，5:4）：纯本地绘制，不联网、不依赖服务器
 *
 * 微信的分享卡片只认 5:4 缩略图，所以这里只画这一张 —— 不存相册、不导图片文件，
 * 用户要图片自己截图（产品决定：少一个入口，少一条权限）。
 *
 * 绘制和文案分开：
 *   posterTexts(data) —— 纯函数，只算文字，能被 node 测到
 *   drawShare(ctx, data) —— 只负责画，逻辑里不做任何数据计算
 */

const TER = require('./terrain');

const SW = 1080;
const SH = 864;

const C = {
  bg: '#23261E',
  ink: '#F5F2E8',
  dim: 'rgba(245,242,232,.52)',
  faint: 'rgba(245,242,232,.30)',
  rule: 'rgba(245,242,232,.16)',
  clay: '#C98A67',
  claySoft: 'rgba(201,138,103,.22)'
};

const SANS = '"LJSans", -apple-system, "PingFang SC", sans-serif';
const GROT = '"LJGrotesk", "LJSans", sans-serif';

/** 数字统一口径：三张战报数字卡怎么显示，海报上就怎么显示 */
function posterTexts(d) {
  const r = (d && d.r) || {};
  const unit = r.unit === 'bw'
    ? { v: String(r.reps || 0), k: '次' }
    : (r.unit === 'sec' ? { v: String(r.seconds || 0), k: '秒' } : { v: String(r.ton || 0), k: '吨' });

  return {
    kicker: (d && d.dateText) || '',
    en: 'SESSION REPORT',
    title: (d && d.head) || '',
    plan: r.planName || '',
    nums: [
      { v: String(r.sets || 0), k: '组' },
      unit,
      { v: String(r.exercises || 0), k: '个动作' }
    ],
    prs: (r.prs || []).slice(0, 3).map(function (p) {
      return (p.cn || '') + ' ' + (p.text || '');
    }),
    comment: (d && d.comment) || '',
    foot: '练界 · 把每一次训练留在身体上'
  };
}

/** 画一条 12 周山脊（海报与分享图共用：形状语言必须一致） */
function ridge(ctx, series, top, base, x0, x1, opts) {
  const o = opts || {};
  const peak = Math.max.apply(null, series) || 1;
  const heights = series.map(function (v) { return Math.max(0.04, v / peak); });
  const n = heights.length;
  const pts = heights.map(function (v, i) {
    return { x: x0 + (x1 - x0) * (i / (n - 1)), y: base - (base - top) * v };
  });

  const g = ctx.createLinearGradient(0, top, 0, base);
  g.addColorStop(0, 'rgba(201,138,103,.34)');
  g.addColorStop(1, 'rgba(201,138,103,.02)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach(function (p) { ctx.lineTo(p.x, p.y); });
  ctx.lineTo(x1, base);
  ctx.lineTo(x0, base);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = C.clay;
  ctx.lineWidth = o.lw || 3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach(function (p) { ctx.lineTo(p.x, p.y); });
  ctx.stroke();

  const last = pts[n - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, o.dot || 9, 0, Math.PI * 2);
  ctx.fillStyle = C.ink;
  ctx.fill();
  return pts;
}

/**
 * 分享卡片的缩略图（5:4）。微信分享卡片只认 5:4，所以这是另一张图，
 * 不是战报海报的裁剪——手机上卡片很小，只放最想被看见的东西。
 */
function drawShare(ctx, d) {
  const t = posterTexts(d);
  const PAD = 72;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, SW, SH);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C.dim;
  ctx.font = '500 24px ' + GROT;
  ctx.fillText(t.kicker, PAD, 96);

  ctx.fillStyle = C.ink;
  let size = 64;
  ctx.font = '700 ' + size + 'px ' + SANS;
  while (ctx.measureText(t.title).width > SW - PAD * 2 && size > 40) {
    size -= 4;
    ctx.font = '700 ' + size + 'px ' + SANS;
  }
  ctx.fillText(t.title, PAD, 196);

  if (t.plan) {
    ctx.fillStyle = C.dim;
    ctx.font = '400 26px ' + SANS;
    ctx.fillText(t.plan, PAD, 242);
  }

  ctx.fillStyle = C.rule;
  ctx.fillRect(PAD, 286, SW - PAD * 2, 2);

  // 两个大数字：组 + 吨（或者 次 / 秒，跟着动作类型走）
  const two = [t.nums[0], t.nums[1]];
  const colW = (SW - PAD * 2) / 2;
  two.forEach(function (n, i) {
    const cx = PAD + colW * i;
    ctx.fillStyle = C.ink;
    ctx.font = '700 96px ' + GROT;
    ctx.fillText(n.v, cx, 412);
    ctx.fillStyle = C.dim;
    ctx.font = '400 24px ' + SANS;
    ctx.fillText(n.k, cx, 452);
    if (i === 0) {
      ctx.fillStyle = C.rule;
      ctx.fillRect(cx + colW - 30, 330, 2, 122);
    }
  });

  const series = (d && d.series) || [];
  if (series.length >= 2 && series.some(function (v) { return v > 0; })) {
    ridge(ctx, series, 520, 700, PAD + 6, SW - PAD - 6, { lw: 3, dot: 8 });
  }

  ctx.fillStyle = C.rule;
  ctx.fillRect(PAD, SH - 96, SW - PAD * 2, 2);
  ctx.fillStyle = C.dim;
  ctx.font = '400 22px ' + SANS;
  ctx.fillText(t.foot, PAD, SH - 54);
}

module.exports = { drawShare: drawShare, posterTexts: posterTexts, SW: SW, SH: SH, COLORS: C };
