/**
 * 力量地形
 *
 * 按原型的设计：横轴是时间（12 周前 → 本周），纵轴是每周「完成了几组」。
 * 每一周是一个点，点连成山脊，山与山之间的谷就是没练或练得少的周。
 * 所以它看起来像一条山脉的轮廓，而不是雷达图。
 *
 * 四个刻意的选择：
 *   1. 用直线段，不做平滑。锯齿感是「山」的质感，平滑了就变成折线图了。
 *   2. 填充从山顶往下渐隐，像山体的阴影。
 *   3. 本周那个点用陶土色标出来，是「你现在站在哪」。
 *   4. 纵轴只给三档刻度（顶 / 中 / 0）+ 两条极淡的虚线：
 *      山有多高得说得清，但不能让网格抢了山。
 *      **单位直接写在顶端刻度上**（「50 组」）——之前靠页面上另起一行 10px 小字交代，
 *      实测用户根本找不到那行字（2026-11-11），单位必须跟数字长在一起。
 *
 * ⚠️ 纵轴是**组数**，不是吨。原因：动作库 105 个动作里 51 个自重 + 10 个计时，
 * 都没有「重量 × 次数」。按吨画，练自重的那几周会塌成贴地的深谷（看着像白练），
 * 混练的人更是完全看不见自重组。组数任何动作都算得出来。
 * 吨数没有消失——它还留在数据页的 TOTAL / BEST 两张卡里。
 */

const LAB_W = 40;      // 左侧刻度栏：数字右对齐到 LAB_W - 6，轴线画在 LAB_W 处
                       // 40 而不是 30：顶端刻度要放得下「50 组」这种带单位的标签
const TOP_PAD = 9;
const BOT_PAD = 5;
const X_PAD = 6;       // 右侧留白：本周那个圆点才不会被 canvas 边缘裁掉

/**
 * 把一批真实数值收口到一个「好看的」纵轴上限：1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 × 10^n。
 * 这样刻度是整数，最高的那座山也不会顶到最上面那条线。
 */
function niceScale(values) {
  const raw = (values || []).reduce(function (a, v) {
    return Math.max(a, Number(v) || 0);
  }, 0);
  if (!(raw > 0)) return 1;

  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  for (let i = 0; i < steps.length; i++) {
    if (raw <= steps[i] * p * 1.0000001) return steps[i] * p;
  }
  return 10 * p;
}

/** 刻度数字：去掉没意义的小数位（8.0 → 8，4.5 → 4.5） */
function fmtTick(v) {
  if (v >= 100) return String(Math.round(v));
  const r = Math.round(v * 10) / 10;
  return String(r);
}

/**
 * 顶端刻度的文字：「50 组」。只给顶部那档带单位，中间和 0 不带 ——
 * 三档都写单位会像三个标签，只有顶部带一个才像「轴的单位」。
 */
function tickLabel(v, unit) {
  const s = fmtTick(v);
  return unit ? s + ' ' + unit : s;
}

/**
 * @param ctx    canvas 2d context
 * @param w,h    逻辑尺寸（已按 dpr 缩放）
 * @param values 0~1 的数组，每个元素是一周的高度（已经除过 scale）
 * @param opt    { scale: 纵轴顶端的真实数值, unit: 顶端刻度后面跟的单位（如 '组'） }
 */
function drawRidge(ctx, w, h, values, opt) {
  const o = opt || {};
  const scale = o.scale > 0 ? o.scale : 1;
  const n = values.length;
  if (!n) return;

  const innerH = h - TOP_PAD - BOT_PAD;
  const span = w - LAB_W - X_PAD;

  // 高度 → 坐标（0 贴基线，1 贴最上面那条线）
  const yOf = function (v) {
    const c = Math.max(0, Math.min(1, v));
    return h - BOT_PAD - c * innerH;
  };

  const pts = values.map(function (v, i) {
    return {
      x: n > 1 ? LAB_W + (i / (n - 1)) * span : LAB_W + span / 2,
      y: yOf(v)
    };
  });

  ctx.clearRect(0, 0, w, h);

  /* ---- 纵轴：轴线 + 三档刻度（顶 / 中 / 0）+ 两条极淡的虚线 ---- */
  ctx.lineWidth = 1;

  ctx.strokeStyle = 'rgba(44, 56, 38, .22)';
  ctx.beginPath();
  ctx.moveTo(LAB_W, TOP_PAD);
  ctx.lineTo(LAB_W, h - BOT_PAD);
  ctx.stroke();

  ctx.font = '9px "LJGrotesk", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(44, 56, 38, .46)';

  const marks = [1, 0.5, 0];
  for (let i = 0; i < marks.length; i++) {
    const k = marks[i];
    const y = yOf(k);

    // 刻度线：从轴线往右伸一点；顶 / 中部再拉一条极淡的虚线网格
    ctx.strokeStyle = 'rgba(44, 56, 38, .22)';
    ctx.beginPath();
    ctx.moveTo(LAB_W, y);
    ctx.lineTo(LAB_W + 4, y);
    ctx.stroke();

    if (k > 0) {
      ctx.strokeStyle = 'rgba(44, 56, 38, .12)';
      if (ctx.setLineDash) ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(LAB_W + 5, y);
      ctx.lineTo(w - X_PAD, y);
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
    }

    // 顶端刻度带单位（「50 组」），中间和 0 只给数字
    ctx.fillText(k === 1 ? tickLabel(scale * k, o.unit) : fmtTick(scale * k), LAB_W - 6, y);
  }

  /* ---- 山体：面积填充，山顶深、山脚淡（山脚收在 0 那条基线上，不留一道悬空） ---- */
  const baseY = yOf(0);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(pts[n - 1].x, baseY);
  ctx.lineTo(pts[0].x, baseY);
  ctx.closePath();

  const g = ctx.createLinearGradient(0, TOP_PAD, 0, baseY);
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
 * 从 `db.weeklyVolume()` 的结果里取「画地形用的那一列」：每周完成组数。
 * 单独抽成函数是为了让它能被测到（写在页面里的话，if 分支在 node 里测不到）。
 * @param {Array<{sets:number, ton:number}>} weeks
 * @returns {number[]}
 */
function seriesOf(weeks) {
  return (weeks || []).map(function (w) { return Number(w.sets) || 0; });
}

/**
 * 把每周组数换算成 0~1 的高度（相对纵轴上限 scale）。
 * 留一个下限 0.015：完全没练的周是一条贴着基线的谷，
 * 山脊线压在轴线上会看不清，抬一点点让它还看得见。
 */
function toHeights(values, scale) {
  const s = scale > 0 ? scale : niceScale(values);
  return (values || []).map(function (t) {
    const v = Number(t) || 0;
    return Math.max(0.015, Math.min(1, v / s));
  });
}

module.exports = { drawRidge, toHeights, niceScale, seriesOf, tickLabel };
