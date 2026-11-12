const db = require('../../utils/db');
const D = require('../../utils/date');
const CHART = require('../../utils/metricChart');
const enterFx = require('../../utils/enter').enterFx;

const SHOW_POINTS = 30;   // 图上最多画最近 30 次记录

/** 底部那行日期：今天 / 昨天 / 10.03 */
function dateLabel(d, today) {
  if (d === today) return '今天';
  if (d === D.shift(today, -1)) return '昨天';
  return String(d).slice(5).replace('-', '.');
}

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
    pickDate: '',      // 正在录入/查看的那一天（默认今天，可以往前翻着补）
    pickLabel: '今天',
    minDate: '',
    saved: false,      // 选中的那天已经有值
    chartEmpty: true
  },

  onLoad() {
    enterFx(this);      // 详情页：内容从右侧推进来（见 utils/enter.js）
    const app = getApp();
    const today = D.today();
    this.setData({
      sbh: app.globalData.statusBarHeight,
      kinds: db.metricKinds(),
      today: today,
      pickDate: today,
      pickLabel: dateLabel(today, today),
      minDate: D.shift(today, -365)
    });
    this.chartHeight = 0;
  },

  onShow() { this.refresh(); },

  refresh() {
    const kind = this.data.active;
    const today = D.today();
    const pickDate = this.data.pickDate || today;
    const series = db.metricSeries(kind, { limit: SHOW_POINTS });
    const latest = db.latestMetric(kind);
    const delta = db.metricDelta(kind, 30);
    const pickedRow = db.metricOf(kind, pickDate);

    const records = db.metricSeries(kind).slice(-8).reverse().map(function (r) {
      return {
        date: r.date.slice(5).replace('-', '.'),
        full: r.date,
        value: r.value,
        unit: r.unit,
        isToday: r.date === today,
        picked: r.date === pickDate
      };
    });

    this._series = series;
    this.setData({
      def: db.metricDef(kind),
      latest: latest,
      delta: delta,
      records: records,
      empty: !series.length,
      today: today,
      pickDate: pickDate,
      pickLabel: dateLabel(pickDate, today),
      saved: !!pickedRow,
      inputValue: pickedRow ? String(pickedRow.value) : (pickDate === today ? this.data.inputValue : ''),
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

  /** 底部日期选择：可以往回补录，最远一年 */
  onPickDate(e) {
    const d = e.detail && e.detail.value;
    if (!d || d === this.data.pickDate) return;
    this.setData({ pickDate: d, inputValue: '' });
    this.refresh();
  },

  /** 点「最近记录」里的一行 → 切到那天，方便改已经记过的值 */
  pickRow(e) {
    const d = e.currentTarget.dataset.date;
    if (!d || d === this.data.pickDate) return;
    this.setData({ pickDate: d, inputValue: '' });
    this.refresh();
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
    const saved = db.saveMetric({ kind: this.data.active, date: this.data.pickDate, value: Number(raw) });
    if (!saved) {
      wx.showToast({ title: '超出合理范围（' + def.min + '~' + def.max + def.unit + '）', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已记下 ' + saved.value + saved.unit, icon: 'none' });
    this.refresh();
  },

  /** 删掉某一天的值：从记录行点 × 进来，或者删当前选中的那天 */
  removeAt(e) {
    const self = this;
    const d = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.date) || this.data.pickDate;
    const label = dateLabel(d, D.today());
    wx.showModal({
      title: '删掉「' + label + '」这条？',
      content: '只删「' + this.data.def.cn + '」这一天的值，其它天不动。',
      success(res) {
        if (!res.confirm) return;
        db.removeMetric(self.data.active, d);
        if (d === self.data.pickDate) self.setData({ inputValue: '' });
        self.refresh();
      }
    });
  },

  back() {
    wx.navigateBack();
  }
});
