/**
 * 力量地形：把各部位的训练强度画成一个有机的多边形。
 *
 * 为什么用 canvas 而不是图片：
 *   形状是由数据算出来的，每个人的地形都不一样，
 *   练得多的部位往外凸，没练的往里凹。所以只能画。
 *
 * 为什么形状是这样：
 *   6 个顶点按部位固定顺序排（胸/背/肩/臂/腿/核心），
 *   每个顶点到中心的距离 = 基础半径 × (0.35 + 0.65 × 该部位占比归一化)。
 *   顶点之间用二次贝塞尔取中点连接，所以边缘是圆的，不是折线，
 *   看起来才像「地形」而不是「雷达图」。
 */

const CX_RATIO = 0.5;
const CY_RATIO = 0.52;

/** 平滑闭合路径：以一个顶点的中点为起点，相邻两个顶点之间用二次贝塞尔 */
function smoothPath(ctx, pts) {
  const n = pts.length;
  if (n < 3) return;

  const mid = function (a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const start = mid(pts[n - 1], pts[0]);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);

  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const m = mid(cur, next);
    ctx.quadraticCurveTo(cur.x, cur.y, m.x, m.y);
  }
  ctx.closePath();
}

/** 正多边形顶点（从正上方开始，顺时针） */
function polygonPoints(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

/**
 * 绘制
 * @param ctx  canvas 2d context
 * @param w,h  逻辑尺寸（已按 dpr 缩放过的坐标空间）
 * @param parts  [{ key, name, pct }] 长度建议 6
 */
function draw(ctx, w, h, parts) {
  ctx.clearRect(0, 0, w, h);

  const cx = w * CX_RATIO;
  const cy = h * CY_RATIO;
  const R = Math.min(w, h) * 0.38;      // 最外圈半径
  const n = parts.length;
  if (!n) return;

  /* ---- 底：三圈同心网格 ---- */
  const rings = [1, 0.72, 0.44];
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  for (let r = 0; r < rings.length; r++) {
    smoothPath(ctx, polygonPoints(cx, cy, R * rings[r], n));
    ctx.strokeStyle = 'rgba(60, 74, 50, ' + (0.10 + r * 0.03) + ')';
    ctx.stroke();
  }
  ctx.setLineDash([]);

  /* ---- 中轴 ---- */
  const axis = polygonPoints(cx, cy, R, n);
  ctx.strokeStyle = 'rgba(60, 74, 50, .07)';
  ctx.lineWidth = 1;
  axis.forEach(function (p) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });

  /* ---- 数据形状 ---- */
  const maxPct = parts.reduce(function (a, p) { return Math.max(a, p.pct || 0); }, 0);
  const pts = parts.map(function (p, i) {
    // 归一化：最强的部位到 0.95R，没练过的最小也有 0.28R（不然会缩成一个点）
    const k = maxPct > 0 ? (p.pct || 0) / maxPct : 0;
    const r = R * (0.35 + 0.6 * k);
    const a = -Math.PI / 2 + i * (Math.PI * 2 / n);
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, pct: p.pct || 0 };
  });

  // 填充：从中心往外淡出，像地形的坡
  const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, R);
  grad.addColorStop(0, 'rgba(60, 74, 50, .42)');
  grad.addColorStop(1, 'rgba(60, 74, 50, .14)');

  smoothPath(ctx, pts);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.strokeStyle = 'rgba(60, 74, 50, .72)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  /* ---- 顶点小圆 ---- */
  pts.forEach(function (p, i) {
    const trained = parts[i].pct > 0;
    ctx.beginPath();
    ctx.arc(p.x, p.y, trained ? 3 : 2, 0, Math.PI * 2);
    ctx.fillStyle = trained ? '#3C4A32' : 'rgba(60, 74, 50, .22)';
    ctx.fill();
  });

  /* ---- 中心点 ---- */
  ctx.beginPath();
  ctx.arc(cx, cy, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(60, 74, 50, .5)';
  ctx.fill();
}

module.exports = { draw, polygonPoints };
