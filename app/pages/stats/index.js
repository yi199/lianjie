const db = require('../../utils/db');
const D = require('../../utils/date');
const store = require('../../store/index');

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
    this.refresh();
  },

  onShow() {
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

  gotoToday() {
    wx.switchTab({ url: '/pages/today/index' });
  }
});
