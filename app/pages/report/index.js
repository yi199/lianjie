const db = require('../../utils/db');
const kit = require('../../utils/tabkit');
const D = require('../../utils/date');
const enterFx = require('../../utils/enter').enterFx;
const poster = require('../../utils/poster');

/** 当天「练了多少」的主数字：负重看吨，自重看次数，计时看秒数 */
function amountText(r) {
  if (r.unit === 'bw') return r.reps + ' 次';
  if (r.unit === 'sec') return r.seconds + ' 秒';
  return r.ton + ' 吨';
}

Page({
  data: {
    sbh: 20,
    isToday: true,
    dayWord: '今天',
    head: '今天练完了。',
    btnText: '完成',
    dateText: '',
    r: {
      planName: '', sets: 0, plannedSets: 0, exercises: 0,
      ton: 0, reps: 0, seconds: 0, unit: 'kg', parts: [], prs: []
    },
    comment: ''
  },

  onLoad(query) {
    enterFx(this);      // 详情页：内容从右侧推进来（见 utils/enter.js）
    const app = getApp();
    const date = (query && query.date) || D.today();

    const r = db.todayReport(date);

    // 从数据页日历点进来的可能是过去某天：文案要跟着换，别对着上周三说「今天」
    const isToday = date === D.today();
    const dayWord = isToday ? '今天' : '那天';

    let comment;
    if (!r.sets) {
      comment = isToday
        ? '今天还没有记录。练一组，这里就有东西了。'
        : '这天没有训练记录。';
    } else if (r.plannedSets && r.sets >= r.plannedSets) {
      comment = '计划全部完成。好好吃一顿，好好睡。';
    } else if (r.plannedSets) {
      comment = '计划 ' + r.plannedSets + ' 组，完成 ' + r.sets + ' 组。留点力气给下次也好。';
    } else {
      comment = dayWord + '练了 ' + r.sets + ' 组。';
    }

    this.setData({
      sbh: app.globalData.statusBarHeight,
      isToday: isToday,
      dayWord: dayWord,
      head: r.sets ? (isToday ? '今天练完了。' : '那天练完了。') : (isToday ? '今天还没开练。' : '那天没有记录。'),
      btnText: isToday ? '完成' : '回到数据',
      dateText: D.weekdayCN(new Date(date + 'T00:00:00')) + ' · ' + date.replace(/-/g, '.'),
      r: r,
      comment: comment
    });

    // 破纪录时轻微震动一下，只一次
    if (r.prs.length) {
      try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* 忽略 */ }
    }

    // 分享：提前把 5:4 的卡片缩略图画好（onShareAppMessage 只能同步返回，来不及现画）
    this.prepShare();

    // 让右上角「···」里出现「分享到朋友圈」（小程序在朋友圈里是半屏卡片，不是一张图）
    try {
      wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
    } catch (e) { /* 老版本没有 shareTimeline，不影响分享给朋友 */ }
  },

  /**
   * 生成分享卡片用的 5:4 缩略图。
   * 失败就静默放弃：没有 imageUrl 时微信会用页面截图，分享照样能用。
   */
  prepShare() {
    const self = this;
    let canvas = null;
    try {
      canvas = wx.createOffscreenCanvas({ type: '2d', width: poster.SW, height: poster.SH });
    } catch (e) { return; }

    let series = [];
    try {
      series = db.weeklyVolume(12).map(function (w) { return w.sets; });
    } catch (e) { /* 没山就不画山 */ }

    try {
      poster.drawShare(canvas.getContext('2d'), {
        r: this.data.r,
        dateText: this.data.dateText,
        head: this.data.head,
        comment: this.data.comment,
        series: series
      });
    } catch (e) { return; }

    try {
      wx.canvasToTempFilePath({
        canvas: canvas,
        x: 0, y: 0,
        width: poster.SW, height: poster.SH,
        destWidth: poster.SW, destHeight: poster.SH,
        fileType: 'jpg',
        success: function (res) { self.shareImg = res.tempFilePath; },
        fail: function () { /* 用页面截图兜底 */ }
      });
    } catch (e) { /* 同上 */ }
  },

  done() {
    // 今天 → 回今天的训练页；翻过去某天 → 退回数据页，别把人扔到「今天」去
    if (this.data.isToday) {
      kit.backToShell(0);
      return;
    }
    wx.navigateBack({
      fail: function () { kit.backToShell(1); }
    });
  },

  /** 分享给朋友 / 群：小程序卡片，缩略图用 5:4 的战报图 */
  onShareAppMessage() {
    const r = this.data.r;
    const msg = {
      title: r.sets
        ? '今天练了 ' + r.sets + ' 组 · ' + amountText(r)
        : '练界 · 把每一次训练留在身体上',
      // 别人点开时没有「那天的数据」，所以落在首页而不是战报页
      path: '/pages/welcome/index'
    };
    if (this.shareImg) msg.imageUrl = this.shareImg;
    return msg;
  },

  /** 分享到朋友圈：微信只支持「半屏小程序卡片」，不支持直接发一张图 */
  onShareTimeline() {
    const r = this.data.r;
    const msg = {
      title: r.sets
        ? '今天练了 ' + r.sets + ' 组 · ' + amountText(r) + ' · 练界'
        : '练界 · 把每一次训练留在身体上',
      query: ''
    };
    if (this.shareImg) msg.imageUrl = this.shareImg;
    return msg;
  }
});
