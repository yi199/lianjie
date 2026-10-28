const db = require('../../utils/db');
const D = require('../../utils/date');
const store = require('../../store/index');

const REST_SECONDS = 90;
const BREATH_CYCLE = 8;   // 4 秒吸气 + 4 秒呼气

Page({
  data: {
    sbh: 20,
    planName: '',
    planKey: '',
    idx: 0,
    total: 0,
    pnum: '01',
    pct: 0,
    isLast: false,
    ex: {},
    lastText: '',
    sugHint: '',
    sets: [],
    plates: [],
    resting: false,
    restText: '01:30',
    restPct: 100,
    restPhase: '吸气'
  },

  onLoad() {
    const app = getApp();
    this.date = D.today();
    this.timer = null;
    this.restLeft = REST_SECONDS;
    this.maxBefore = 0;

    this.setData({ sbh: app.globalData.statusBarHeight });

    const s = db.todaySession();
    if (!s.plan || !s.plan.items.length) {
      wx.showToast({ title: '还没有训练计划', icon: 'none' });
      setTimeout(function () { wx.navigateBack(); }, 700);
      return;
    }

    this.plan = s.plan;
    this.planKey = s.plan.key;

    this.setData({
      planName: s.plan.name,
      planKey: s.plan.key,
      total: s.plan.items.length
    });
    this.loadEx(0);
  },

  onUnload() {
    this.clearTimer();
  },

  /* ---------- 载入第 i 个动作 ---------- */
  loadEx(i) {
    const it = this.plan.items[i];
    this.maxBefore = db.maxWeightBefore(it.exId, this.date);

    // 渐进超负荷：上次全部达标就加一档
    const sug = db.suggestWeight(it.exId, it.reps, this.date);
    const weight = sug.reason === 'first' ? it.weight : sug.weight;

    const sets = [];
    for (let k = 0; k < it.sets; k++) {
      sets.push({
        no: k + 1,
        weight: weight,
        reps: it.reps,
        unit: it.unit || 'kg',
        done: false,
        pr: false
      });
    }

    let lastText = '第一次做这个动作';
    let sugHint = '';
    if (sug.reason === 'up') {
      lastText = '上次 ' + sug.prev + ' kg × ' + it.reps + ' × ' + it.sets;
      sugHint = '全部完成，今天加 ' + sug.step + ' kg';
    } else if (sug.reason === 'keep') {
      lastText = '上次 ' + sug.prev + ' kg × ' + it.reps + ' × ' + it.sets;
      sugHint = '上次没做满，今天保持';
    }

    this.clearTimer();
    this.setData({
      idx: i,
      ex: it,
      sets: sets,
      pnum: ('0' + (i + 1)).slice(-2),
      pct: Math.round((i + 1) / this.plan.items.length * 100),
      isLast: i === this.plan.items.length - 1,
      lastText: lastText,
      sugHint: sugHint,
      resting: false,
      restText: '01:30',
      restPct: 100,
      restPhase: '吸气'
    });

    this.refreshPlates();
  },

  /**
   * 重算杠铃片。
   * 一组一片：完成了点亮；重量超过历史最好成绩的那一组，用陶土色。
   */
  refreshPlates() {
    const maxBefore = this.maxBefore || 0;
    const plates = this.data.sets.map(function (s) {
      return {
        no: s.no,
        on: !!s.done,
        pr: s.unit === 'kg' && s.weight > 0 && maxBefore > 0 && s.weight > maxBefore
      };
    });
    this.setData({ plates: plates });
  },

  /* ---------- 换动作 ---------- */
  changeEx() {
    const alts = db.alternatives(this.data.ex.exId);
    if (!alts.length) {
      wx.showToast({ title: '没有同部位可换的动作', icon: 'none' });
      return;
    }

    const list = alts.slice(0, 6);
    const self = this;
    wx.showActionSheet({
      itemList: list.map(function (a) { return a.cn; }),
      success(res) {
        self.swapEx(list[res.tapIndex]);
      },
      fail() { /* 用户取消 */ }
    });
  },

  /** 换掉当前动作，组数不变，重量按新动作重新建议 */
  swapEx(pick) {
    const cur = this.data.ex;
    const n = this.data.sets.length || cur.sets;
    const sug = db.suggestWeight(pick.id, cur.reps, this.date);

    let weight = 0;
    if (pick.unit === 'kg') {
      weight = sug.reason === 'first' ? 20 : sug.weight;
    }

    const sets = [];
    for (let k = 0; k < n; k++) {
      sets.push({
        no: k + 1,
        weight: weight,
        reps: cur.reps,
        unit: pick.unit,
        done: false,
        pr: false
      });
    }

    this.maxBefore = db.maxWeightBefore(pick.id, this.date);

    this.setData({
      ex: {
        exId: pick.id,
        cn: pick.cn,
        en: pick.en,
        part: pick.part,
        sets: n,
        reps: cur.reps,
        weight: weight,
        unit: pick.unit
      },
      sets: sets,
      lastText: sug.reason === 'first' ? '第一次做这个动作' : '上次 ' + sug.prev + ' kg',
      sugHint: sug.reason === 'up' ? '全部完成，今天加 ' + sug.step + ' kg' : ''
    });

    this.refreshPlates();
    wx.showToast({ title: '换成 ' + pick.cn, icon: 'none' });
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
      this.persist(target);
      this.startRest();
      try { wx.vibrateShort({ type: 'light' }); } catch (err) { /* 忽略 */ }
    } else {
      this.stopRest();
    }

    this.refreshPlates();
  },

  /* ---------- 改重量 / 改次数 ---------- */
  onWeightChange(e) {
    this.applySetChange(e.detail.no, { weight: e.detail.value });
  },

  onRepsChange(e) {
    this.applySetChange(e.detail.no, { reps: e.detail.value });
  },

  /**
   * 改某一组的数值。
   * 已勾选的组立刻落库（否则统计还是旧数字）；
   * 没勾选的只改页面上的值，等勾选时一起存。
   */
  applySetChange(no, patch) {
    let target = null;
    const sets = this.data.sets.map(function (s) {
      if (s.no === no) {
        target = Object.assign({}, s, patch);
        return target;
      }
      return s;
    });
    this.setData({ sets: sets });

    if (target && target.done) this.persist(target);
    this.refreshPlates();
  },

  /** 加一组：照最后一组的重量次数复制一份 */
  addSet() {
    const sets = this.data.sets.slice();
    const ref = sets.length ? sets[sets.length - 1] : this.data.ex;
    if (sets.length >= 10) {
      wx.showToast({ title: '最多 10 组', icon: 'none' });
      return;
    }
    sets.push({
      no: sets.length + 1,
      weight: ref.weight,
      reps: ref.reps,
      unit: ref.unit || 'kg',
      done: false,
      pr: false
    });
    this.setData({ sets: sets });
    this.refreshPlates();
  },

  /** 写入一条组记录（勾选和改数值共用） */
  persist(row) {
    db.saveSet({
      date: this.date,
      exId: this.data.ex.exId,
      exCn: this.data.ex.cn,
      part: this.data.ex.part,
      planKey: this.planKey,
      setNo: row.no,
      weight: row.weight,
      reps: row.reps,
      unit: row.unit
    });
    store.touchSets();
  },

  /* ---------- 组间休息：呼吸环 ---------- */
  startRest() {
    const self = this;
    this.clearTimer();
    this.restLeft = REST_SECONDS;
    this.setData({ resting: true, restText: '01:30', restPct: 100, restPhase: '吸气' });

    this.timer = setInterval(function () {
      self.restLeft -= 1;
      if (self.restLeft <= 0) {
        self.stopRest();
        return;
      }
      const m = Math.floor(self.restLeft / 60);
      const s = self.restLeft % 60;
      const elapsed = REST_SECONDS - self.restLeft;
      const half = BREATH_CYCLE / 2;
      const phase = Math.floor(elapsed % BREATH_CYCLE / half) === 0 ? '吸气' : '呼气';

      self.setData({
        restText: ('0' + m).slice(-2) + ':' + ('0' + s).slice(-2),
        restPct: Math.round(self.restLeft / REST_SECONDS * 100),
        restPhase: phase
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
    if (this.data.isLast) {
      this.finish();
      return;
    }
    this.loadEx(this.data.idx + 1);
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  finish() {
    this.clearTimer();
    if (!db.todaySets(this.date).length) {
      wx.showToast({ title: '还没记录任何一组', icon: 'none' });
      return;
    }
    wx.redirectTo({ url: '/pages/report/index?date=' + this.date });
  },

  back() {
    wx.navigateBack();
  }
});
