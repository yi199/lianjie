const db = require('../../utils/db');

Page({
  data: {
    sbh: 20,
    profile: { days: 3, place: 'gym', level: 'some' },
    profileText: '',
    planKeys: [],
    enter: false
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
    const p = db.profile() || { days: 3, place: 'gym', level: 'some' };
    const keys = db.plans().map(function (x) {
      return { key: x.key, name: x.name };
    });
    this.setData({
      profile: p,
      profileText: db.profileText(),
      planKeys: keys
    });
  },

  /**
   * 改任何一项都会重新生成计划，已有的训练记录保留。
   *
   * 手动调参数 = 要「按参数自动排」，所以顺手把 programId 清成 auto：
   * 否则正在用某个方案时，这里改天数/场所/水平根本不会生效。
   */
  apply(patch) {
    const p = Object.assign({}, this.data.profile, patch, { programId: 'auto' });
    db.saveProfile(p);
    this.refresh();
    wx.showToast({ title: '已按参数重排', icon: 'none' });
  },

  gotoPrograms() {
    wx.navigateTo({ url: '/pages/programs/index' });
  },

  setDays(e) {
    this.apply({ days: Number(e.currentTarget.dataset.v) });
  },

  setPlace(e) {
    this.apply({ place: e.currentTarget.dataset.v });
  },

  setLevel(e) {
    this.apply({ level: e.currentTarget.dataset.v });
  },

  fillDemo() {
    const n = db.loadDemo();
    if (!n) {
      wx.showToast({ title: '还没有计划', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已填入 ' + n + ' 条示例', icon: 'none' });
  },

  clearData() {
    const self = this;
    wx.showModal({
      title: '清空训练记录',
      content: '所有练过的组都会被删掉，计划设置保留。确定吗？',
      confirmText: '清空',
      confirmColor: '#B4795A',
      success(res) {
        if (!res.confirm) return;
        db.clearSets();
        wx.showToast({ title: '已清空', icon: 'none' });
        self.refresh();
      }
    });
  },

  restart() {
    const self = this;
    wx.showModal({
      title: '重新引导',
      content: '会清掉计划设置和所有训练记录，回到第一次打开的状态。',
      confirmText: '重新开始',
      confirmColor: '#B4795A',
      success(res) {
        if (!res.confirm) return;
        db.resetAll();
        wx.reLaunch({ url: '/pages/welcome/index' });
      }
    });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
