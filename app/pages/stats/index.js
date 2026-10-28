const db = require('../../utils/db');
const D = require('../../utils/date');

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
    empty: false
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
    const m = D.thisMonth();
    const s = db.monthlyStats(m.y, m.m);
    const wk = db.weeklyProgress();
    const blankN = D.firstWeekdayMon(m.y, m.m);

    const blanks = [];
    for (let i = 0; i < blankN; i++) blanks.push(i);

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
      empty: s.days === 0
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
  }
});
