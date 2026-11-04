/**
 * 身体指标趋势图（Canvas 2D 自绘）
 *
 * 和力量地形同一套视觉语言：
 *   - 直线段，不做平滑（平滑会让「今天突然涨了」看着很温柔）
 *   - 面积从上往下渐隐，像一层影子
 *   - 最后一个点用陶土色标出来，是「你现在在哪」
 *
 * 不画网格、不画坐标轴文字：数据点少的时候网格只会变成噪音，
 * 数字交给页面上现成的文字（最新值 / 变化量）。
 */

/**
 * @param ctx    canvas 2d context
 * @param w,h    逻辑尺寸（已按 dpr 缩放）
 * @param points [{date, value}] 按日期升序，至少 1 个
 * @param opt    { down: boolean } down=true 表示「越小越好」（体脂/腰围/心率），
 *               只影响填充色：变好是绿色，变差是陶土色
 */
function drawTrend(ctx, w, h, points, opt) {
  const o = opt || {};
  if (!points || !points.length) return;

  const padY = 14;
  const padX = 10;
  const innerH = h - padY * 2;
  const innerW = w - padX * 2;

  const vals = points.map(function (p) { return p.value; });
  let min = Math.min.apply(null, vals);
  let max = Math.max.apply(null, vals);
  if (max - min < 0.0001) { max = min + 1; min = min - 1; }   // 只有一个值：给条平线的空间

  const n = points.length;
  const pts = points.map(function (p, i) {
    const x = n > 1 ? padX + (i / (n - 1)) * innerW : w / 2;
    const y = padY + (1 - (p.value - min) / (max - min)) * innerH;
    return { x: x, y: y, v: p.value };
  });

  ctx.clearRect(0, 0, w, h);

  // 变好还是变差（第一个点 → 最后一个点）
  const first = vals[0];
  const last = vals[n - 1];
  const better = o.down ? last < first : last > first;
  const tone = n > 1 && last !== first ? (better ? '60, 90, 50' : '180, 121, 90') : '60, 74, 50';

  // 面积
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(pts[n - 1].x, h);
  ctx.lineTo(pts[0].x, h);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, padY, 0, h);
  g.addColorStop(0, 'rgba(' + tone + ', .22)');
  g.addColorStop(1, 'rgba(' + tone + ', .02)');
  ctx.fillStyle = g;
  ctx.fill();

  // 折线
  if (n > 1) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = '#2C3826';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // 最后一点
  const lastPt = pts[n - 1];
  ctx.beginPath();
  ctx.arc(lastPt.x, lastPt.y, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = '#B4795A';
  ctx.fill();
  ctx.strokeStyle = '#F2F0E6';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

module.exports = { drawTrend: drawTrend };
