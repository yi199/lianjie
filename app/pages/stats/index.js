const db = require('../../utils/db');
const D = require('../../utils/date');
const TER = require('../../utils/terrain');
const kit = require('../../utils/tabkit');
const store = require('../../store/index');

/** 地形下面那句评语：说清哪座山最高、哪块还平，给一个具体建议 */
function makeComment(parts) {
  if (!parts || !parts.length) return '';
  const sorted = parts.slice().sort(function (a, b) { return b.pct - a.pct; });
  const strong = sorted[0];
  const weak = sorted[sorted.length - 1];

  if (sorted.length === 1) {
    return strong.name + '一个人扛下了这个月。别的部位也分一点，地形才不会只有一座孤峰。';
  }
  if (weak.pct === 0) {
    return strong.name + '堆出了主峰，' + weak.name + '还是一片平地。下周补一次' + weak.name + '，地形会更好看。';
  }
  return strong.name + '和' + sorted[1].name + '堆出了主峰，' +
    weak.name + '还是一条浅淡的坡。下周加一次' + weak.name + '，地形会更好看。';
}

const cfg = {
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
    empty: false,
    totalTon: 0,
    bestTon: 0,
    totalDays: 0,
    totalShown: 0,
    bestShown: 0,
    amountUnit: '吨',
    comment: ''
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });
    this.heights = [];

    // 远端变更（别的设备记的组）同步下来后即时重算，包括力量地形。
    // 切 tab 不销毁页面，所以监听会一直挂着——切回来立刻就是最新数据。
    const self = this;
    this.onSetsChange = function () { self.refresh(); };
    store.on(this.onSetsChange);
  },

  onUnload() {
    if (this.onSetsChange) store.off(this.onSetsChange);
  },

  onShow() {
    if (!db.hasOnboarded()) {
      wx.reLaunch({ url: '/pages/welcome/index' });
      return;
    }
    this.refresh();
    this.playEnter();
  },

  /**
   * 进场分两种：
   *   - 第一次进入：内容逐块往上长（.enter，错峰 30ms），有质感
   *   - 切 tab 回来：只做 120ms 的整体淡入（.enter-fade）
   *     tab 页是常驻实例，重播错峰入场看起来像「整页重新加载」——用户反馈说切换僵硬
   */
  playEnter() {
    const self = this;
    const first = !this._entered;
    this._entered = true;
    this.setData({ fx: '' });
    setTimeout(function () {
      self.setData({ fx: first ? 'enter' : 'enter-fade' });
    }, 24);
  },

  refresh() {
    const m = D.thisMonth();
    const s = db.monthlyStats(m.y, m.m);
    const wk = db.weeklyProgress();
    const all = db.allTimeStats();
    const blankN = D.firstWeekdayMon(m.y, m.m);

    const blanks = [];
    for (let i = 0; i < blankN; i++) blanks.push(i);

    // 地形：最近 12 周「每周练了多少组」→ 归一化成 0~1 的高度
    //
    // 为什么不是吨：自重（俯卧撑/引体/徒手深蹲）和计时（平板支撑）都没有「重量×次数」，
    // 动作库里 105 个动作有 51 个自重 + 10 个计时。按吨画，只做自重的那几周会塌成
    // 贴地的深谷（看着像「白练了」），混练的人更是完全看不见自重组。
    // 组数任何动作都算得出来，不挑类型，也不需要用户填体重。
    // 吨数没有消失：它还留在下面的 TOTAL / BEST 两张卡里，负重党照样看得见强度。
    const wv = db.weeklyVolume(12);
    const raw = TER.seriesOf(wv);
    // 纵轴上限定在「好看的数」上（5 / 8 / 12 …），刻度才是整数，最高的山也不顶格
    this.scale = TER.niceScale(raw);
    this.heights = TER.toHeights(raw, this.scale);

    // 三个数字卡同理：负重看吨，自重 / 计时看组
    const hasTon = all.totalTon > 0;

    const self = this;
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
      empty: s.days === 0,
      totalTon: all.totalTon,
      bestTon: all.best,
      totalDays: all.days,
      totalShown: hasTon ? all.totalTon : all.totalSets,
      bestShown: hasTon ? all.best : all.bestSets,
      amountUnit: hasTon ? '吨' : '组',
      hasTon: hasTon,
      hasDemo: db.hasDemo(),
      comment: makeComment(s.parts)
    }, function () {
      // canvas 要等节点渲染完才拿得到
      if (s.days > 0) self.drawTerrain();
    });
  },

  /** 力量地形：12 周的山脊线 */
  drawTerrain() {
    const self = this;
    wx.createSelectorQuery()
      .in(this)
      .select('#terrain')
      .fields({ node: true, size: true })
      .exec(function (res) {
        if (!res || !res[0] || !res[0].node) return;

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const w = res[0].width;
        const h = res[0].height;
        if (!w || !h) return;

        let dpr = 2;
        try {
          dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2;
        } catch (e) { /* 老基础库 */ }

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        TER.drawRidge(ctx, w, h, self.heights || [], { scale: self.scale, unit: '组' });
      });
  },

  /** 空态时用来「先看看长什么样」，不是真实数据 */
  /** 一键清掉示例数据：真实记录一条不动 */
  clearDemo() {
    const n = db.clearDemo();
    wx.showToast({ title: n ? ('已清掉 ' + n + ' 条示例') : '没有示例数据', icon: 'none' });
    this.refresh();
  },

  gotoToday() {
    kit.goTab(0);
  },

  /**
   * 日历格子 → 那天的战报。
   * 战报页本来就收 ?date=，以前只是没有入口：练过但记错了，只能在当天回不去。
   * 没练的日子点了给一句实话，别让人以为点了没反应。
   */
  openDay(e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset.date : '';
    if (!ds) return;
    const on = !!(e.currentTarget.dataset.on === true || e.currentTarget.dataset.on === 'true');
    if (!on) {
      wx.showToast({ title: '这天没练', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/report/index?date=' + ds });
  },

  /** 「强了多少」是另一个问题，进「进步」页看 */
  gotoProgress() {
    wx.navigateTo({ url: '/pages/progress/index' });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  onShareAppMessage() {
    return {
      title: '练界 · 把每一次训练留在身体上',
      path: '/pages/welcome/index'
    };
  }
};

// 仍然注册成页面：开发者工具里能单独预览，老代码/测试也照旧按页面加载
if (typeof Page === 'function') Page(cfg);

// swiper 容器里的组件复用同一份配置（见 components/tab-*/index.js）
module.exports = cfg;
