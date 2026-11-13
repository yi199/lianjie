const db = require('../../utils/db');
const sync = require('../../utils/sync');
const P = require('../../data/plan');

/**
 * 引导页只做一件事：在 10 秒内让人看到「今天练什么」。
 *
 * 所以没有分步、没有「下一步」：三个问题都预选好默认值，
 * 用户什么都不点，按「就这样，开始」也能拿到一份能用的计划。
 * 想改的人改一项，下面的计划摘要当场重算。
 */

const DEF_LEVEL = 'some';   // 练过一阵
const DEF_DAYS = 3;         // 一周 3 练
const DEF_PLACE = 'gym';    // 健身房

Page({
  data: {
    sbh: 20,
    level: DEF_LEVEL,
    days: DEF_DAYS,
    place: DEF_PLACE,
    summary: '',
    meta: '',
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
      wx.reLaunch({ url: '/pages/shell/index' });
      return;
    }

    // 默认值先算出计划摘要：即使服务端迟迟不回，用户也已经看到「今天练什么」
    this.refresh(DEF_DAYS, DEF_PLACE, DEF_LEVEL);

    // 本地没有引导态，也可能只是「换了设备」。先等服务端配置回来再决定，
    // 否则用户明明用过，清个缓存就要重填一遍表。
    // ready() 自带 4 秒上限，网络慢也不会卡在这里。
    const self = this;
    this.setData({ checking: true });
    sync.ready().then(function () {
      if (db.hasOnboarded()) {
        wx.reLaunch({ url: '/pages/shell/index' });
        return;
      }
      self.setData({ checking: false });
    });
  },

  /** 「继续即表示同意…」→ 隐私政策与用户协议（纯本地也必须有这一页，审核会看） */
  gotoPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' });
  },

  pickLevel(e) {
    const level = e.currentTarget.dataset.v;
    this.setData({ level: level });
    this.refresh(this.data.days, this.data.place, level);
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

  /** 把生成的计划摘要显示出来（跟着选项实时变） */
  refresh(days, place, level) {
    if (!days || !place) {
      this.setData({ summary: '', meta: '' });
      return;
    }
    const plans = P.buildPlan(days, place, level || DEF_LEVEL);
    const names = plans.map(function (p) { return p.name; }).join(' / ');
    this.setData({
      meta: '一周 ' + days + ' 练 · ' + (place === 'home' ? '居家' : '健身房'),
      summary: names
    });
  },

  finish() {
    if (this.data.checking || this.data.leaving) return;

    db.finishOnboarding({
      level: this.data.level || DEF_LEVEL,
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
      wx.reLaunch({ url: '/pages/shell/index' });
    }, 200);
  }
});
