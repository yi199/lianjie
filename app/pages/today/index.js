const db = require('../../utils/db');
const D = require('../../utils/date');

Page({
  data: {
    sbh: 20,
    weekday: '',
    dateText: '',
    plan: { rest: true },
    items: [],
    doneCount: 0,
    lastText: '',
    profileText: ''
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });
  },

  onShow() {
    // 没走完引导不该出现在这里
    if (!db.hasOnboarded()) {
      wx.reLaunch({ url: '/pages/welcome/index' });
      return;
    }
    this.refresh();
  },

  refresh() {
    const plan = db.todayPlan();
    const todaySets = db.todaySets() || [];
    const doneEx = {};
    todaySets.forEach(function (s) { doneEx[s.exId] = true; });

    if (plan.rest) {
      this.setData({
        weekday: D.weekdayCN(),
        dateText: D.prettyDate(),
        plan: plan,
        items: [],
        doneCount: 0,
        lastText: '',
        profileText: db.profileText()
      });
      return;
    }

    const items = plan.items.map(function (it, i) {
      let label;
      if (it.unit === 'sec') label = it.sets + ' × ' + it.reps + '″';
      else if (it.unit === 'bw') label = it.sets + ' × ' + it.reps + ' 次';
      else label = it.sets + ' × ' + it.reps;

      return Object.assign({}, it, {
        no: ('0' + (i + 1)).slice(-2),
        label: label,
        done: !!doneEx[it.exId]
      });
    });

    const last = db.lastRecord(plan.items[0].exId);
    const doneCount = items.filter(function (x) { return x.done; }).length;

    this.setData({
      weekday: D.weekdayCN(),
      dateText: D.prettyDate(),
      plan: plan,
      items: items,
      doneCount: doneCount,
      lastText: last
        ? '上次练这个动作 · ' + last.daysAgo + ' 天前'
        : '第一次练这个动作',
      profileText: db.profileText()
    });
  },

  start() {
    wx.navigateTo({ url: '/pages/record/index' });
  },

  gotoStats() {
    wx.switchTab({ url: '/pages/stats/index' });
  }
});
