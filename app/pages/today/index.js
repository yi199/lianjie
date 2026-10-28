const db = require('../../utils/db');
const D = require('../../utils/date');

Page({
  data: {
    sbh: 20,
    weekday: '',
    dateText: '',
    h1: '',
    plan: null,
    items: [],
    doneCount: 0,
    lastText: '',
    finished: false,
    resumed: false,
    weekDone: 0,
    weekTarget: 0,
    weekDots: [],
    profileText: ''
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
  },

  refresh() {
    const s = db.todaySession();
    const todaySets = db.todaySets() || [];

    const doneEx = {};
    todaySets.forEach(function (x) { doneEx[x.exId] = true; });

    const plan = s.plan;
    const items = plan
      ? plan.items.map(function (it, i) {
          let label;
          if (it.unit === 'sec') label = it.sets + ' × ' + it.reps + '″';
          else if (it.unit === 'bw') label = it.sets + ' × ' + it.reps + ' 次';
          else label = it.sets + ' × ' + it.reps;

          return Object.assign({}, it, {
            no: ('0' + (i + 1)).slice(-2),
            label: label,
            done: !!doneEx[it.exId]
          });
        })
      : [];

    let h1;
    if (!plan) {
      h1 = '还没有计划。';
    } else if (s.finished) {
      h1 = '本周练完了。';
    } else if (s.resumed) {
      h1 = '今天练了一半。';
    } else {
      h1 = '今天练' + plan.name + '。';
    }

    let lastText = '';
    if (plan && plan.items.length) {
      const last = db.lastRecord(plan.items[0].exId);
      lastText = last
        ? '上次练这个 · ' + last.daysAgo + ' 天前'
        : '第一次练这个训练日';
    }

    // 本周进度点
    const dots = [];
    for (let i = 0; i < s.week.target; i++) dots.push(i);

    this.setData({
      weekday: D.weekdayCN(),
      dateText: D.prettyDate(),
      h1: h1,
      plan: plan,
      items: items,
      doneCount: items.filter(function (x) { return x.done; }).length,
      lastText: lastText,
      finished: s.finished,
      resumed: s.resumed,
      weekDone: s.week.done,
      weekTarget: s.week.target,
      weekDots: dots,
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
