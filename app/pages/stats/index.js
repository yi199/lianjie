const db = require('../../utils/db');
const D = require('../../utils/date');
const TER = require('../../utils/terrain');
const store = require('../../store/index');

/** 地形下面那句评语：说清哪座山最高、哪块还平，给一个具体建议 */
function makeComment(parts) {
  if (!parts || !parts.length) return '';
  const sorted = parts.slice().sort(function (a, b) { return b.pct - a.pct; });
  const strong = sorted[0];
  const weak = sorted[sorted.length - 1];

  if (sorted.length === 1) {
    return strong.name + '一个人扛下了这个月。别的部位也分一点，地形才不会只有一座孤峰。';
  }
  if (weak.pct === 0) {
    return strong.name + '堆出了主峰，' + weak.name + '还是一片平地。下周补一次' + weak.name + '，地形会更好看。';
  }
  return strong.name + '和' + sorted[1].name + '堆出了主峰，' +
    weak.name + '还是一条浅淡的坡。下周加一次' + weak.name + '，地形会更好看。';
}

Page({
  data: {
    sbh: 20,
    monthLabel: '',
    days: 0,
    weekDone: 0,
    weekPlanned: 0,
    ton: 0,
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],
    blanks: [],
    cells: [],
    parts: [],
    top: [],
    empty: false,
    enter: false,
    totalTon: 0,
    bestTon: 0,
    totalDays: 0,
    totalShown: 0,
    bestShown: 0,
    amountUnit: '吨',
    comment: ''
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });
    this.heights = [];

    // 远端变更（别的设备记的组）同步下来后即时重算，包括力量地形。
    // 切 tab 不销毁页面，所以监听会一直挂着——切回来立刻就是最新数据。
    const self = this;
    this.onSetsChange = function () { self.refresh(); };
    store.on(this.onSetsChange);
  },

  onUnload() {
    if (this.onSetsChange) store.off(this.onSetsChange);
  },

  onShow() {
    // 自定义 tabBar：页面得主动告诉它当前选中的是第几个
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }

    if (!db.hasOnboarded()) {
      wx.reLaunch({ url: '/pages/welcome/index' });
      return;
    }
    this.refresh();
    this.playEnter();
  },

  playEnter() {
    const self = this;
    this.setData({ enter: false });
    setTimeout(function () { self.setData({ enter: true }); }, 24);
  },

  refresh() {
    const m = D.thisMonth();
    const s = db.monthlyStats(m.y, m.m);
    const wk = db.weeklyProgress();
    const all = db.allTimeStats();
    const blankN = D.firstWeekdayMon(m.y, m.m);

    const blanks = [];
    for (let i = 0; i < blankN; i++) blanks.push(i);

    // 地形：最近 12 周每周的吨数 → 归一化成 0~1 的高度
    // 纯自重 / 计时党没有吨数，退回用组数画，别让地形塌成一条平地
    const wv = db.weeklyVolume(12);
    const loaded = wv.some(function (w) { return w.ton > 0; });
    const raw = wv.map(function (w) { return loaded ? w.ton : w.sets; });
    // 纵轴上限定在「好看的数」上（5 / 8 / 12 …），刻度才是整数，最高的山也不顶格
    this.scale = TER.niceScale(raw);
    this.heights = TER.toHeights(raw, this.scale);

    // 三个数字卡同理：负重看吨，自重 / 计时看组
    const hasTon = all.totalTon > 0;

    const self = this;
    this.setData({
      monthLabel: m.m + ' 月',
      days: s.days,
      weekDone: wk.done,
      weekPlanned: wk.planned,
      ton: s.ton,
      blanks: blanks,
      cells: s.calendar,
      parts: s.parts,
      top: s.top,
      empty: s.days === 0,
      totalTon: all.totalTon,
      bestTon: all.best,
      totalDays: all.days,
      totalShown: hasTon ? all.totalTon : all.totalSets,
      bestShown: hasTon ? all.best : all.bestSets,
      amountUnit: hasTon ? '吨' : '组',
      terrUnit: loaded ? '吨' : '组',
      comment: makeComment(s.parts)
    }, function () {
      // canvas 要等节点渲染完才拿得到
      if (s.days > 0) self.drawTerrain();
    });
  },

  /** 力量地形：12 周的山脊线 */
  drawTerrain() {
    const self = this;
    wx.createSelectorQuery()
      .in(this)
      .select('#terrain')
      .fields({ node: true, size: true })
      .exec(function (res) {
        if (!res || !res[0] || !res[0].node) return;

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const w = res[0].width;
        const h = res[0].height;
        if (!w || !h) return;

        let dpr = 2;
        try {
          dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2;
        } catch (e) { /* 老基础库 */ }

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        TER.drawRidge(ctx, w, h, self.heights || [], { scale: self.scale });
      });
  },

  /** 空态时用来「先看看长什么样」，不是真实数据 */
  loadDemo() {
    const n = db.loadDemo();
    if (!n) {
      wx.showToast({ title: '还没有计划', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已填入 ' + n + ' 条示例', icon: 'none' });
    this.refresh();
  },

  gotoToday() {
    wx.switchTab({ url: '/pages/today/index' });
  },

  /**
   * 日历格子 → 那天的战报。
   * 战报页本来就收 ?date=，以前只是没有入口：练过但记错了，只能在当天回不去。
   * 没练的日子点了给一句实话，别让人以为点了没反应。
   */
  openDay(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset.date : '';
    if (!ds) return;
    const on = !!(e.currentTarget.dataset.on === true || e.currentTarget.dataset.on === 'true');
    if (!on) {
      wx.showToast({ title: '这天没练', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/report/index?date=' + ds });
  },

  /** 「强了多少」是另一个问题，进「进步」页看 */
  gotoProgress() {
    wx.navigateTo({ url: '/pages/progress/index' });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  onShareAppMessage() {
    return {
      title: '练界 · 把每一次训练留在身体上',
      path: '/pages/welcome/index'
    };
  }
});
