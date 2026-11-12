const db = require('../../utils/db');
const P = require('../../utils/progress');
const STR = require('../../utils/strength');

/** 高光 → 一句话（页面只负责讲，判断都在 utils/progress 里） */
function highlightText(h) {
  const raw = function (b) {
    if (!b) return '';
    if (b.unit === 'sec') return b.reps + ' 秒';
    if (b.unit === 'bw') return b.reps + ' 次';
    return b.weight + 'kg × ' + b.reps;
  };
  if (h.kind === 'first') return '第一次做' + h.cn;
  if (h.kind === 'record') return h.cn + ' 新纪录 ' + raw(h.detail.bestSet);
  if (h.kind === 'breakthrough') return h.cn + ' 卡了 ' + h.detail.flat + ' 次之后突破：' + raw(h.detail.bestSet);
  if (h.kind === 'milestone') return h.cn + ' 第一次到 ' + h.detail.mark + (h.unit === '秒' ? ' 秒' : (h.unit === '次' ? ' 次' : 'kg'));
  if (h.kind === 'upgrade') return h.cn + ' 升级：' + h.detail.fromCn + ' → ' + h.detail.toCn;
  if (h.kind === 'streak') return h.cn + ' 第 ' + h.detail.times + ' 次';
  return h.cn;
}

const STATUS_CN = { up: '在涨', flat: '持平', down: '掉了', new: '新动作', stalled: '卡住' };

Page({
  data: {
    sbh: 20,
    cpad: 102,      // 顶行右侧给胶囊让出的 px（app.js 里按真机几何算）
    empty: true,
    demo: false,
    indexText: '1.00',
    upText: '0',
    spanText: '',
    weeks: [],
    parts: [],
    highlights: [],
    actions: [],
    power: { ready: false, reason: '', items: [] },
    openId: '',
    openSeries: [],
    openStall: '',
    openModel: ''
  },

  onLoad() {
    const app = getApp();
    // cpad：「Progress」小标贴右，得给右上角胶囊让位（见 app.js capsulePad）
    this.setData({ sbh: app.globalData.statusBarHeight, cpad: app.globalData.capsulePad || 102 });
  },

  onShow() {
    this.build();
  },

  build() {
    // 有真实记录就只看真实记录；一条都没有时用示例数据给个预览（示例不会污染统计）
    const real = db.allSets().filter(function (s) { return !s.demo && !s.warmup; }).length > 0;
    const o = { includeDemo: !real };
    const ov = P.overallNow(o);
    // 力量水平只看真实记录：示例数据不参与（否则会给出一个假评级）
    const power = real ? STR.strengthNow() : { show: true, ready: false, reason: 'no-data', items: [] };

    if (!ov.ok) {
      this.setData({
        empty: true,
        demo: !real,
        power: power,
        actions: P.actionsNow(o).map(function (a) {
          return { exId: a.exId, cn: a.cn, exposures: a.exposures, need: a.need, status: 'new', statusCn: STATUS_CN.new };
        })
      });
      return;
    }

    // 周走势：最多 12 周，柱高按「相对起点高出多少」映射，基线是 1.00
    const list = ov.weeks.slice(-12);
    const deltas = list.map(function (w) { return w.index - 1; });
    const maxD = Math.max.apply(null, deltas.concat([0.02]));
    const minD = Math.min.apply(null, deltas.concat([0]));
    const weeks = list.map(function (w, i) {
      const d = w.index - 1;
      const h = 10 + ((d - minD) / (maxD - minD || 1)) * 90;    // 柱子高度：越高说明那周整体越强
      return {
        week: w.week,
        index: w.index,
        h: Math.round(h),
        on: i === list.length - 1
      };
    });

    // 首屏最多 6 条，同类最多 2 条：一串「突破停滞」会显得像刷屏，混着看才像故事
    const hls = P.highlightsNow(o);
    const picked = [];
    const perKind = {};
    hls.forEach(function (h) {
      if (picked.length >= 6) return;
      perKind[h.kind] = (perKind[h.kind] || 0) + 1;
      if (perKind[h.kind] > 2) return;
      picked.push(h);
    });
    const highlights = picked.map(function (h, i) {
      const d = h.date || '';
      return { idx: i, kind: h.kind, dateText: d.slice(5).replace('-', '/'), text: highlightText(h) };
    });

    const actions = ov.actions.map(function (a) {
      return {
        exId: a.exId,
        cn: a.cn,
        exposures: a.exposures,
        indexText: a.index.toFixed(2),
        pct: Math.round((a.index - 1) * 100),
        status: a.status,
        statusCn: STATUS_CN[a.status] || a.status,
        modelCn: a.modelCn,
        stall: a.stall && a.stall.stalled ? a.stall : null
      };
    });

    this.setData({
      empty: false,
      demo: !real,
      indexText: ov.index.toFixed(2),
      upText: ov.up > 0 ? '+' + ov.up : String(ov.up),
      spanText: ov.from && ov.to ? (ov.from.slice(5).replace('-', '/') + ' — ' + ov.to.slice(5).replace('-', '/')) : '',
      weeks: weeks,
      parts: (function () {
        const maxD = ov.parts.reduce(function (a, p) { return Math.max(a, Math.abs(p.delta)); }, 0) || 1;
        return ov.parts.map(function (p) {
          const d = Math.round(p.delta);
          return {
            part: p.part, name: p.name, delta: p.delta,
            pct: Math.round(Math.abs(p.delta) / maxD * 100),   // 最长的那个拉满，方便一眼看出强弱
            up: d >= 0
          };
        });
      })(),
      highlights: highlights,
      actions: actions,
      power: power
    });
  },

  /** 点动作行：展开最近 6 次的力量值，顺便把停滞事实说清楚 */
  toggle(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.openId === id) {
      this.setData({ openId: '', openSeries: [], openStall: '', openModel: '' });
      return;
    }

    const real = db.allSets().filter(function (s) { return !s.demo && !s.warmup; }).length > 0;
    const o = { includeDemo: !real };
    const s = P.seriesOf(id, o);
    const items = s.items.slice(-6);
    const vals = items.map(function (it) { return it.value; });
    const max = Math.max.apply(null, vals.concat([0]));
    const min = Math.min.apply(null, vals.concat([max]));
    const span = max - min || 1;
    const t = P.trendOf(id, o);

    this.setData({
      openId: id,
      openModel: P.MODEL_CN[s.attrs.model] || '',
      openSeries: items.map(function (it) {
        // 按「这几次里的高低差」拉伸，绝对值近乎一样时也能看出走势
        return {
          date: it.date.slice(5).replace('-', '/'),
          value: Math.round(it.value * 10) / 10,
          unit: it.unit,
          h: Math.round(20 + (it.value - min) / span * 80),
          conf: it.conf
        };
      }),
      openStall: t.ok && t.stall.stalled
        ? '已经 ' + t.stall.flatCount + ' 次没超过 ' + t.stall.bestValue + '（' + t.stall.bestDate.slice(5).replace('-', '/') + ' 那次）'
        : ''
    });
  },

  /** 「力量水平」缺资料时 → 去我的页填性别 / 记体重 */
  gotoMy() {
    wx.switchTab({ url: '/pages/my/index' });
  },

  gotoMetrics() {
    wx.navigateTo({ url: '/pages/metrics/index' });
  },

  back() {
    wx.navigateBack();
  }
});
