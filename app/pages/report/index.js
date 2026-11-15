const db = require('../../utils/db');
const kit = require('../../utils/tabkit');
const D = require('../../utils/date');
const enterFx = require('../../utils/enter').enterFx;
const poster = require('../../utils/poster');
const snap = require('../../utils/share-snapshot');

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
    // 好友分享快照模式：数据全来自链接，只读，底栏只剩「我也开始练」
    shared: false,
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

    // 好友分享卡片：链接里带着分享者的战报快照，只读渲染，不读本地任何数据
    const shared = snap.decode(query && query.snap);
    if (shared) {
      this.sharedMode = true;
      // 原样保留，好友再转发时同一份快照跟着走
      this.shareToken = query.snap;
      this.setData({
        sbh: app.globalData.statusBarHeight,
        shared: true,
        isToday: false,
        dayWord: shared.dayWord,
        head: shared.head,
        btnText: '我也开始练',
        dateText: shared.dateText,
        r: shared.r,
        comment: shared.comment
      });

      this.prepShare();
      try {
        wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
      } catch (e) { /* 老版本没有 shareTimeline */ }
      return;
    }

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

    // 快照模式下山脊属于好友自己的本地数据，不能画进别人的战报图
    let series = [];
    if (!this.sharedMode) {
      try {
        series = db.weeklyVolume(12).map(function (w) { return w.sets; });
      } catch (e) { /* 没山就不画山 */ }
    }

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
    // 好友的战报快照：按钮叫「我也开始练」，已引导进自己首页，新人进引导页
    if (this.sharedMode) {
      const url = db.hasOnboarded()
        ? '/pages/shell/index'
        : '/pages/welcome/index';
      wx.reLaunch({ url: url });
      return;
    }
    // 今天 → 回今天的训练页；翻过去某天 → 退回数据页，别把人扔到「今天」去
    if (this.data.isToday) {
      kit.backToShell(0);
      return;
    }
    wx.navigateBack({
      fail: function () { kit.backToShell(1); }
    });
  },

  /**
   * 分享给朋友 / 群：小程序卡片，缩略图用 5:4 的战报图。
   * 自己的战报 → 链接带快照，好友点开看到的就是这份战报（只读）；
   * 快照模式下转发 → 原样带上同一快照，不断链。
   */
  onShareAppMessage() {
    const r = this.data.r;

    if (this.sharedMode) {
      const msg = {
        title: r.sets
          ? '今天练了 ' + r.sets + ' 组 · ' + amountText(r)
          : '力见 · 把每一次训练留在身体上',
        path: '/pages/report/index?snap=' + encodeURIComponent(this.shareToken)
      };
      if (this.shareImg) msg.imageUrl = this.shareImg;
      return msg;
    }

    // 自己的战报：打包快照；打包失败（极端超长）回退到旧的落地页路径，分享本身不挂
    const token = snap.encode(r, {
      dateText: this.data.dateText,
      head: this.data.head,
      comment: this.data.comment,
      dayWord: this.data.dayWord
    });
    const msg = {
      title: r.sets
        ? '今天练了 ' + r.sets + ' 组 · ' + amountText(r)
        : '力见 · 把每一次训练留在身体上',
      path: token
        ? '/pages/report/index?snap=' + encodeURIComponent(token)
        : '/pages/welcome/index'
    };
    if (this.shareImg) msg.imageUrl = this.shareImg;
    return msg;
  },

  /** 分享到朋友圈：微信只支持「半屏小程序卡片」，不支持直接发一张图 */
  onShareTimeline() {
    const r = this.data.r;
    const msg = {
      title: r.sets
        ? '今天练了 ' + r.sets + ' 组 · ' + amountText(r) + ' · 力见'
        : '力见 · 把每一次训练留在身体上',
      query: ''
    };

    if (this.sharedMode) {
      msg.query = 'snap=' + encodeURIComponent(this.shareToken);
    } else {
      const token = snap.encode(r, {
        dateText: this.data.dateText,
        head: this.data.head,
        comment: this.data.comment,
        dayWord: this.data.dayWord
      });
      if (token) msg.query = 'snap=' + encodeURIComponent(token);
    }

    if (this.shareImg) msg.imageUrl = this.shareImg;
    return msg;
  }
});
