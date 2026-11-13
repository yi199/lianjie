/**
 * 战报海报（1080×1440，3:4）：纯本地绘制，不联网、不依赖服务器
 *
 * 为什么做这个：练完发一张图是健身用户的本能，也是这个产品唯一不花钱的传播口子。
 * 绘制和文案分开：
 *   posterTexts(data) —— 纯函数，只算文字，能被 node 测到
 *   draw(ctx, data)   —— 只负责画，逻辑里不做任何数据计算
 */

const TER = require('./terrain');

const W = 1080;
const H = 1440;

// 分享卡片缩略图固定 5:4（微信分享卡片的比例），和海报（3:4）是两张图
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

/** 按宽度折行：中文没有空格，只能一个字一个字量 */
function wrap(ctx, text, maxW) {
  const out = [];
  let line = '';
  (text || '').split('').forEach(function (ch) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxW && line) {
      out.push(line);
      line = ch;
    } else {
      line = next;
    }
  });
  if (line) out.push(line);
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * 把海报画到 ctx 上。ctx 的逻辑尺寸按 W×H（调用方先 scale(dpr, dpr)）。
 * @param {object} d { r, dateText, head, series: [每周组数…] }
 */
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

function draw(ctx, d) {
  const t = posterTexts(d);
  const PAD = 84;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  /* ---- 顶部 ---- */
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = C.dim;
  ctx.font = '500 26px ' + GROT;
  ctx.fillText(t.kicker, PAD, 132);

  ctx.fillStyle = C.faint;
  ctx.font = 'italic 500 24px ' + GROT;
  ctx.fillText(t.en, PAD, 176);

  // 大标题：最多两行，超了就缩字号（标题是「今天练完了。」这种短句，正常一行）
  ctx.fillStyle = C.ink;
  let size = 76;
  ctx.font = '700 ' + size + 'px ' + SANS;
  while (ctx.measureText(t.title).width > W - PAD * 2 && size > 44) {
    size -= 4;
    ctx.font = '700 ' + size + 'px ' + SANS;
  }
  ctx.fillText(t.title, PAD, 282);

  if (t.plan) {
    ctx.fillStyle = C.dim;
    ctx.font = '400 28px ' + SANS;
    ctx.fillText(t.plan, PAD, 336);
  }

  ctx.fillStyle = C.rule;
  ctx.fillRect(PAD, 384, W - PAD * 2, 2);

  /* ---- 三个数字 ---- */
  const colW = (W - PAD * 2) / 3;
  t.nums.forEach(function (n, i) {
    const cx = PAD + colW * i;
    ctx.fillStyle = C.ink;
    ctx.font = '700 104px ' + GROT;
    ctx.fillText(n.v, cx, 512);
    ctx.fillStyle = C.dim;
    ctx.font = '400 26px ' + SANS;
    ctx.fillText(n.k, cx, 556);
    if (i < 2) {
      ctx.fillStyle = C.rule;
      ctx.fillRect(cx + colW - 34, 424, 2, 132);
    }
  });

  /* ---- PR（有才画） ---- */
  let y = 648;
  if (t.prs.length) {
    ctx.fillStyle = C.clay;
    ctx.font = '500 24px ' + GROT;
    ctx.fillText('PERSONAL BEST', PAD, y);
    y += 46;
    ctx.font = '400 30px ' + SANS;
    t.prs.forEach(function (line) {
      ctx.fillStyle = C.ink;
      ctx.fillText(line, PAD, y);
      y += 46;
    });
  }

  /* ---- 评语：PR 和山脊之间那块空白用它填，也是这个产品该有的语气 ---- */
  if (t.comment) {
    ctx.fillStyle = C.dim;
    ctx.font = '400 30px ' + SANS;
    const lines = wrap(ctx, t.comment, W - PAD * 2).slice(0, 2);
    lines.forEach(function (ln, i) {
      ctx.fillText(ln, PAD, (t.prs.length ? y + 34 : y) + i * 44);
    });
  }

  /* ---- 地形：最近 12 周的山脊（没有数据就不画，别画个假的） ---- */
  const series = (d && d.series) || [];
  if (series.length >= 2 && series.some(function (v) { return v > 0; })) {
    const top = 1032;
    const base = 1210;
    const x0 = PAD + 6;
    const x1 = W - PAD - 6;
    // 海报没有刻度：按实际最大值归一，山才有起伏（不用 niceScale）
    ridge(ctx, series, top, base, x0, x1, { lw: 3, dot: 9 });

    ctx.fillStyle = C.faint;
    ctx.font = '400 22px ' + SANS;
    ctx.textAlign = 'left';
    ctx.fillText('12 周前', x0, base + 44);
    ctx.textAlign = 'right';
    ctx.fillText('本周', x1, base + 44);
    ctx.textAlign = 'left';
  }

  /* ---- 底部 ---- */
  ctx.fillStyle = C.rule;
  ctx.fillRect(PAD, H - 132, W - PAD * 2, 2);
  ctx.fillStyle = C.dim;
  ctx.font = '400 24px ' + SANS;
  ctx.fillText(t.foot, PAD, H - 84);
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

module.exports = { draw: draw, drawShare: drawShare, posterTexts: posterTexts, W: W, H: H, SW: SW, SH: SH, COLORS: C };
