const db = require('../../utils/db');
const D = require('../../utils/date');

/** 当天「练了多少」的主数字：负重看吨，自重看次数，计时看秒数 */
function amountText(r) {
  if (r.unit === 'bw') return r.reps + ' 次';
  if (r.unit === 'sec') return r.seconds + ' 秒';
  return r.ton + ' 吨';
}

Page({
  data: {
    sbh: 20,
    dateText: '',
    r: {
      planName: '', sets: 0, plannedSets: 0, exercises: 0,
      ton: 0, reps: 0, seconds: 0, unit: 'kg', parts: [], prs: []
    },
    comment: ''
  },

  onLoad(query) {
    const app = getApp();
    const date = (query && query.date) || D.today();

    const r = db.todayReport(date);

    let comment;
    if (!r.sets) {
      comment = '今天还没有记录。练一组，这里就有东西了。';
    } else if (r.plannedSets && r.sets >= r.plannedSets) {
      comment = '计划全部完成。好好吃一顿，好好睡。';
    } else if (r.plannedSets) {
      comment = '计划 ' + r.plannedSets + ' 组，完成 ' + r.sets + ' 组。留点力气给下次也好。';
    } else {
      comment = '今天练了 ' + r.sets + ' 组。';
    }

    this.setData({
      sbh: app.globalData.statusBarHeight,
      dateText: D.weekdayCN(new Date(date + 'T00:00:00')) + ' · ' + date.replace(/-/g, '.'),
      r: r,
      comment: comment
    });

    // 破纪录时轻微震动一下，只一次
    if (r.prs.length) {
      try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* 忽略 */ }
    }
  },

  done() {
    wx.switchTab({ url: '/pages/today/index' });
  },

  onShareAppMessage() {
    const r = this.data.r;
    return {
      title: r.sets
        ? '今天练了 ' + r.sets + ' 组 · ' + amountText(r)
        : '练界 · 把每一次训练留在身体上',
      path: '/pages/welcome/index'
    };
  }
});
