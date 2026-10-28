const db = require('../../utils/db');
const P = require('../../data/plan');

Page({
  data: {
    sbh: 20,
    step: 0,          // 0 品牌 / 1 水平 / 2 频率与场所
    level: '',
    days: 0,
    place: '',
    canFinish: false,
    summary: ''
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });

    // 从旧版本升级上来的，先清掉老的假数据
    db.migrate();

    // 已经走过引导，直接进首页（不重复打扰）
    if (db.hasOnboarded()) {
      wx.reLaunch({ url: '/pages/today/index' });
    }
  },

  start() {
    this.setData({ step: 1 });
  },

  back() {
    this.setData({ step: Math.max(0, this.data.step - 1) });
  },

  /** 选水平 → 自动进下一步 */
  pickLevel(e) {
    this.setData({ level: e.currentTarget.dataset.v, step: 2 });
  },

  pickDays(e) {
    const days = Number(e.currentTarget.dataset.v);
    this.setData({ days: days });
    this.refresh(days, this.data.place, this.data.level);
  },

  pickPlace(e) {
    const place = e.currentTarget.dataset.v;
    this.setData({ place: place });
    this.refresh(this.data.days, place, this.data.level);
  },

  /** 两项都选了才允许开始，并把生成的计划摘要显示出来 */
  refresh(days, place, level) {
    if (!days || !place) {
      this.setData({ canFinish: false, summary: '' });
      return;
    }
    const plans = P.buildPlan(days, place, level || 'some');
    const names = Object.keys(plans).map(function (k) { return plans[k].name; }).join(' / ');
    this.setData({
      canFinish: true,
      summary: '一周 ' + days + ' 练 · ' + (place === 'home' ? '居家' : '健身房') + ' · ' + names
    });
  },

  finish() {
    if (!this.data.canFinish) return;

    db.finishOnboarding({
      level: this.data.level || 'some',
      days: this.data.days,
      place: this.data.place
    });

    wx.reLaunch({ url: '/pages/today/index' });
  }
});
