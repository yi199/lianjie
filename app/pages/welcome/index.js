const db = require('../../utils/db');
const sync = require('../../utils/sync');
const P = require('../../data/plan');

Page({
  data: {
    sbh: 20,
    step: 0,          // 0 品牌 / 1 水平 / 2 频率与场所
    level: '',
    days: 0,
    place: '',
    canFinish: false,
    summary: '',
    leaving: false,
    checking: false   // 正在等服务端配置（本地没有引导态时）
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });

    // 从旧版本升级上来的，先清掉老的假数据
    db.migrate();

    // 已经走过引导，直接进首页（不重复打扰）
    if (db.hasOnboarded()) {
      wx.reLaunch({ url: '/pages/today/index' });
      return;
    }

    // 本地没有引导态，也可能只是「换了设备」。先等服务端配置回来再决定，
    // 否则用户明明用过，清个缓存就要重填一遍表。
    // ready() 自带 4 秒上限，网络慢也不会卡在这里。
    const self = this;
    this.setData({ checking: true });
    sync.ready().then(function () {
      if (db.hasOnboarded()) {
        wx.reLaunch({ url: '/pages/today/index' });
        return;
      }
      self.setData({ checking: false });
    });
  },

  start() {
    if (this.data.checking) return;    // 还在等同步，别让人抢先点进引导
    this.setData({ step: 1 });
  },

  back() {
    this.setData({ step: Math.max(0, this.data.step - 1) });
  },

  /** 「继续即表示同意…」→ 隐私政策与用户协议（纯本地也必须有这一页，审核会看） */
  gotoPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' });
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
    const names = plans.map(function (p) { return p.name; }).join(' / ');
    this.setData({
      canFinish: true,
      summary: '一周 ' + days + ' 练 · ' + (place === 'home' ? '居家' : '健身房') + ' · ' + names
    });
  },

  finish() {
    if (!this.data.canFinish || this.data.leaving) return;

    db.finishOnboarding({
      level: this.data.level || 'some',
      days: this.data.days,
      place: this.data.place
    });

    // 引导走完之后必须踢一次同步，否则永远不同步：
    //   App.onLaunch 时还没走完引导，sync.init() 会直接跳过；
    //   而这里的 wx.reLaunch 不触发 App.onShow，所以没人调 sync.kick()。
    // 不 await：失败由 sync 自己退避重试，不该挡住「进首页」。
    sync.kick();

    // 先淡出再跳，避免从引导页硬切到首页
    this.setData({ leaving: true });
    setTimeout(function () {
      wx.reLaunch({ url: '/pages/today/index' });
    }, 200);
  }
});
