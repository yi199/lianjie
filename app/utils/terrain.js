/**
 * 力量地形
 *
 * 按原型的设计：横轴是时间（12 周前 → 本周），纵轴是每周的训练量。
 * 每一周是一个点，点连成山脊，山与山之间的谷就是没练或练得少的周。
 * 所以它看起来像一条山脉的轮廓，而不是雷达图。
 *
 * 三个刻意的选择：
 *   1. 用直线段，不做平滑。锯齿感是「山」的质感，平滑了就变成折线图了。
 *   2. 填充从山顶往下渐隐，像山体的阴影。
 *   3. 本周那个点用陶土色标出来，是「你现在站在哪」。
 */

/**
 * @param ctx   canvas 2d context
 * @param w,h   逻辑尺寸（已按 dpr 缩放）
 * @param values 0~1 的数组，每个元素是一周的高度
 */
function drawRidge(ctx, w, h, values) {
  const n = values.length;
  if (!n) return;

  const pad = 12;      // 上下留白
  const xPad = 6;      // 左右留白：本周那个圆点才不会被边框裁掉
  const inner = h - pad * 2;
  const span = w - xPad * 2;

  const pts = values.map(function (v, i) {
    return {
      x: n > 1 ? xPad + (i / (n - 1)) * span : w / 2,
      y: h - pad - Math.max(0.05, Math.min(1, v)) * inner
    };
  });

  ctx.clearRect(0, 0, w, h);

  /* ---- 山体：面积填充，山顶深、山脚淡 ---- */
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(pts[n - 1].x, h);
  ctx.lineTo(pts[0].x, h);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, pad, 0, h);
  g.addColorStop(0, 'rgba(60, 74, 50, .78)');
  g.addColorStop(1, 'rgba(60, 74, 50, .08)');
  ctx.fillStyle = g;
  ctx.fill();

  /* ---- 山脊线：直线段，保留锯齿 ---- */
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = '#2C3826';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  /* ---- 本周：陶土色圆点 ---- */
  const last = pts[n - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = '#B4795A';
  ctx.fill();
  ctx.strokeStyle = '#F2F0E6';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

/**
 * 把每周吨数换算成 0~1 的高度。
 * 留一个下限 0.12：完全没练的周也不会贴到底，
 * 不然地形会缺一块，看起来像图画坏了。
 */
function toHeights(tons) {
  const max = tons.reduce(function (a, t) { return Math.max(a, t); }, 0);
  return tons.map(function (t) {
    if (max <= 0) return 0.12;
    return 0.12 + 0.88 * (t / max);
  });
}

module.exports = { drawRidge, toHeights };
