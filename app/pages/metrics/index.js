const db = require('../../utils/db');
const D = require('../../utils/date');
const CHART = require('../../utils/metricChart');

const SHOW_POINTS = 30;   // 图上最多画最近 30 次记录

Page({
  data: {
    sbh: 20,
    kinds: [],
    active: 'weight',
    def: null,
    latest: null,
    delta: null,
    records: [],       // 最近 8 条，倒序
    empty: true,
    inputValue: '',
    today: '',
    saved: false,      // 今天已经有值 → 显示「删除今天」
    chartEmpty: true
  },

  onLoad() {
    const app = getApp();
    this.setData({
      sbh: app.globalData.statusBarHeight,
      kinds: db.metricKinds(),
      today: D.today()
    });
    this.chartHeight = 0;
  },

  onShow() { this.refresh(); },

  refresh() {
    const kind = this.data.active;
    const today = D.today();
    const series = db.metricSeries(kind, { limit: SHOW_POINTS });
    const latest = db.latestMetric(kind);
    const delta = db.metricDelta(kind, 30);
    const todayRow = db.metricOf(kind, today);

    const records = db.metricSeries(kind).slice(-8).reverse().map(function (r) {
      return { date: r.date.slice(5).replace('-', '.'), value: r.value, unit: r.unit, isToday: r.date === today };
    });

    this._series = series;
    this.setData({
      def: db.metricDef(kind),
      latest: latest,
      delta: delta,
      records: records,
      empty: !series.length,
      today: today,
      saved: !!todayRow,
      inputValue: todayRow ? String(todayRow.value) : this.data.inputValue,
      chartEmpty: series.length < 2
    }, this.draw.bind(this));
  },

  draw() {
    if (this.data.chartEmpty) return;
    const self = this;
    wx.createSelectorQuery()
      .in(this)
      .select('#trend')
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

        // 体脂、腰围、静息心率都是「低了更好」
        const down = self.data.active !== 'weight';
        CHART.drawTrend(ctx, w, h, self._series || [], { down: down });
      });
  },

  switchKind(e) {
    const kind = e.currentTarget.dataset.kind;
    if (!kind || kind === this.data.active) return;
    this.setData({ active: kind, inputValue: '' }, this.refresh.bind(this));
  },

  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  save() {
    const raw = String(this.data.inputValue || '').trim().replace(',', '.');
    if (!raw) {
      wx.showToast({ title: '先填个数', icon: 'none' });
      return;
    }
    const def = db.metricDef(this.data.active);
    const saved = db.saveMetric({ kind: this.data.active, date: this.data.today, value: Number(raw) });
    if (!saved) {
      wx.showToast({ title: '超出合理范围（' + def.min + '~' + def.max + def.unit + '）', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已记下 ' + saved.value + saved.unit, icon: 'none' });
    this.refresh();
  },

  removeToday() {
    const self = this;
    wx.showModal({
      title: '删掉今天这条？',
      content: '只删「' + this.data.def.cn + '」今天的值，以前的不动。',
      success(res) {
        if (!res.confirm) return;
        db.removeMetric(self.data.active, self.data.today);
        self.setData({ inputValue: '' });
        self.refresh();
      }
    });
  },

  back() {
    wx.navigateBack();
  }
});
