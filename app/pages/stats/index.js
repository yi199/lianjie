const db = require('../../utils/db');
const D = require('../../utils/date');
const TER = require('../../utils/terrain');

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
    terrain: [],
    terrainAny: false,
    weeks: []
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });
  },

  onShow() {
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
    const blankN = D.firstWeekdayMon(m.y, m.m);

    const blanks = [];
    for (let i = 0; i < blankN; i++) blanks.push(i);

    // 力量地形：6 个部位，没练过的记 0
    const terrain = db.partTerrain(m.y, m.m);
    const terrainAny = terrain.some(function (t) { return t.pct > 0; });

    // 近 8 周训练量，柱高按最高一周归一化（留 16% 给标签和顶部空间）
    const rawWeeks = db.weeklyVolume(8);
    const maxTon = rawWeeks.reduce(function (a, w) { return Math.max(a, w.ton); }, 0);
    const weeks = rawWeeks.map(function (w) {
      const h = maxTon > 0 ? Math.round(w.ton / maxTon * 84) : 0;
      return { label: w.label, ton: w.ton, h: w.ton > 0 ? Math.max(6, h) : 0 };
    });

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
      terrain: terrain,
      terrainAny: terrainAny,
      weeks: weeks
    }, function () {
      // canvas 要等节点渲染出来才能拿到
      if (terrainAny) self.drawTerrain();
    });
  },

  /** 力量地形：把 6 个部位的强度画成一个有机形状 */
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

        TER.draw(ctx, w, h, self.data.terrain);
      });
  },

  /** 空态时用来「先看看长什么样」，不是真实数据 */
  loadDemo() {
    const n = db.loadDemo();
    if (n === -1) {
      wx.showToast({ title: '已经有记录了，示例不会覆盖', icon: 'none' });
      return;
    }
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
