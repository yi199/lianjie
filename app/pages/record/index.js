const db = require('../../utils/db');
const D = require('../../utils/date');
const store = require('../../store/index');

const REST_SECONDS = 90;

Page({
  data: {
    sbh: 20,
    planName: '',
    idx: 0,
    total: 0,
    pnum: '01',
    pct: 0,
    ex: {},
    lastText: '',
    sets: [],
    resting: false,
    restText: '01:30',
    restPct: 100
  },

  onLoad() {
    const app = getApp();
    this.date = D.today();
    this.plan = db.todayPlan(this.date);
    this.timer = null;
    this.restLeft = REST_SECONDS;

    this.setData({ sbh: app.globalData.statusBarHeight });

    if (this.plan.rest || !this.plan.items || !this.plan.items.length) {
      wx.showToast({ title: '今天没有训练安排', icon: 'none' });
      setTimeout(function () { wx.navigateBack(); }, 700);
      return;
    }

    this.setData({
      planName: this.plan.name,
      total: this.plan.items.length
    });
    this.loadEx(0);
  },

  onUnload() {
    this.clearTimer();
  },

  /* ---------- 载入第 i 个动作 ---------- */
  loadEx(i) {
    const it = this.plan.items[i];
    const last = db.lastRecord(it.exId, this.date);
    const sets = [];
    for (let k = 0; k < it.sets; k++) {
      sets.push({
        no: k + 1,
        weight: it.weight,
        reps: it.reps,
        unit: it.unit || 'kg',
        done: false,
        pr: false
      });
    }
    this.clearTimer();
    this.setData({
      idx: i,
      ex: it,
      sets: sets,
      pnum: ('0' + (i + 1)).slice(-2),
      pct: Math.round((i + 1) / this.plan.items.length * 100),
      lastText: last
        ? '上次 ' + last.weight + ' kg × ' + last.reps + ' × ' + last.sets
        : '第一次做这个动作',
      resting: false,
      restText: '01:30',
      restPct: 100
    });
  },

  /* ---------- 勾选一组 ---------- */
  onToggle(e) {
    const no = e.detail.no;
    let target = null;
    const sets = this.data.sets.map(function (s) {
      if (s.no === no) {
        target = Object.assign({}, s, { done: !s.done });
        return target;
      }
      return s;
    });

    this.setData({ sets: sets });

    if (!target) return;

    if (target.done) {
      db.saveSet({
        date: this.date,
        exId: this.data.ex.exId,
        exCn: this.data.ex.cn,
        part: this.data.ex.part,
        setNo: no,
        weight: target.weight,
        reps: target.reps,
        unit: target.unit
      });
      store.touchSets();
      this.startRest();
      try { wx.vibrateShort({ type: 'light' }); } catch (err) { /* 忽略 */ }
    } else {
      this.stopRest();
    }
  },

  /* ---------- 休息倒计时 ---------- */
  startRest() {
    const self = this;
    this.clearTimer();
    this.restLeft = REST_SECONDS;
    this.setData({ resting: true, restText: '01:30', restPct: 100 });

    this.timer = setInterval(function () {
      self.restLeft -= 1;
      if (self.restLeft <= 0) {
        self.stopRest();
        return;
      }
      const m = Math.floor(self.restLeft / 60);
      const s = self.restLeft % 60;
      self.setData({
        restText: ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2),
        restPct: Math.round(self.restLeft / REST_SECONDS * 100)
      });
    }, 1000);
  },

  stopRest() {
    this.clearTimer();
    if (this.data.resting) this.setData({ resting: false });
  },

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  /* ---------- 下一个动作 / 结束 ---------- */
  nextEx() {
    const next = this.data.idx + 1;
    if (next < this.plan.items.length) {
      this.loadEx(next);
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
      return;
    }
    this.finish();
  },

  finish() {
    const self = this;
    this.clearTimer();
    const done = db.todaySets(this.date).length;
    wx.showModal({
      title: '今天练完了',
      content: '记录了 ' + done + ' 组。要看看这个月的进度吗？',
      confirmText: '看数据',
      cancelText: '回首页',
      success(res) {
        if (res.confirm) {
          wx.switchTab({ url: '/pages/stats/index' });
        } else {
          wx.navigateBack();
        }
      }
    });
  },

  back() {
    wx.navigateBack();
  }
});
