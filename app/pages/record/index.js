const db = require('../../utils/db');
const D = require('../../utils/date');
const store = require('../../store/index');

const REST_SECONDS = 90;
const BREATH_CYCLE = 8;   // 4 秒吸气 + 4 秒呼气

/** 「上次 50 kg × 10 × 3 组」/「上次 12 次 × 3 组」/「上次 30 秒 × 3 组」 */
function describeLast(lr, unit) {
  if (!lr) return '';
  if (unit === 'sec') return '上次 ' + lr.reps + ' 秒 × ' + lr.sets + ' 组';
  if (unit === 'bw') return '上次 ' + lr.reps + ' 次 × ' + lr.sets + ' 组';
  return '上次 ' + lr.weight + ' kg × ' + lr.reps + ' × ' + lr.sets + ' 组';
}

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

  onLoad(opts) {
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

    // 从首页点某个动作进来 → 直接到那个动作；
    // 否则接着上次没做完的地方开始（中途退出不会又从第一个动作重来）
    const doneEx = {};
    db.todaySets(this.date).forEach(function (x) { doneEx[x.exId] = true; });

    const want = opts && opts.i !== undefined ? Number(opts.i) : NaN;
    let start = 0;
    if (!isNaN(want) && want >= 0 && want < s.plan.items.length) {
      start = want;
    } else {
      for (let k = 0; k < s.plan.items.length; k++) {
        if (!doneEx[s.plan.items[k].exId]) { start = k; break; }
      }
    }

    this.loadEx(start);
  },

  onUnload() {
    this.clearTimer();
  },

  /* ---------- 载入第 i 个动作 ---------- */
  loadEx(i) {
    const it = this.plan.items[i];
    this.maxBefore = db.maxWeightBefore(it.exId, this.date);

    // 渐进超负荷：上次做够组数、且每组都达标，才加一档
    const sug = db.suggestWeight(it.exId, it.reps, it.sets, this.date);
    const weight = sug.reason === 'first' ? it.weight : sug.weight;

    // 今天已经勾过的组必须还原：否则中途退出再进来，全变回未勾选，用户会以为白练了
    const prevRows = db.todaySets(this.date).filter(function (s) { return s.exId === it.exId; });
    const byNo = {};
    prevRows.forEach(function (s) { byNo[s.setNo] = s; });

    const totalSets = Math.max(it.sets, prevRows.length);
    const sets = [];
    for (let k = 0; k < totalSets; k++) {
      const rec = byNo[k + 1];
      sets.push({
        no: k + 1,
        weight: rec ? rec.weight : weight,
        reps: rec ? rec.reps : it.reps,
        unit: it.unit || 'kg',
        done: !!rec,
        pr: false
      });
    }

    let lastText = '第一次做这个动作';
    let sugHint = '';
    if (sug.reason === 'up') {
      lastText = '上次 ' + sug.prev + ' kg × ' + it.reps + ' × ' + sug.sets + ' 组';
      sugHint = '全部完成，今天加 ' + sug.step + ' kg';
    } else if (sug.reason === 'keep') {
      lastText = '上次 ' + sug.prev + ' kg × ' + it.reps + ' × ' + sug.sets + ' 组';
      sugHint = sug.enoughSets
        ? '上次没做满，今天保持'
        : '上次只做了 ' + sug.sets + ' 组（计划 ' + it.sets + ' 组），今天保持';
    } else if (it.unit !== 'kg') {
      // 自重 / 计时动作没有重量可建议，就只说上次做了多少
      lastText = describeLast(db.lastRecord(it.exId, this.date), it.unit) || '第一次做这个动作';
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

  /** 换掉当前动作：记住这次替换，重量按新动作自己的基线算 */
  swapEx(pick) {
    const cur = this.data.ex;
    const i = this.data.idx;
    const slot = (cur.slot === undefined) ? i : cur.slot;
    const n = this.data.sets.length || cur.sets;
    const planSets = cur.sets || n;

    // 记住替换：下次进这个训练日还是它，不用每天重换一遍
    db.setSwap(this.planKey, slot, pick.id);

    const sug = db.suggestWeight(pick.id, cur.reps, planSets, this.date);

    let weight = 0;
    if (pick.unit === 'kg') {
      // 第一次做这个动作，用它的基线重量，不能一律给 20kg
      weight = sug.reason === 'first' ? db.initialWeight(pick.id) : sug.weight;
    }

    const prevRows = db.todaySets(this.date).filter(function (s) { return s.exId === pick.id; });
    const byNo = {};
    prevRows.forEach(function (s) { byNo[s.setNo] = s; });

    const totalSets = Math.max(n, prevRows.length);
    const sets = [];
    for (let k = 0; k < totalSets; k++) {
      const rec = byNo[k + 1];
      sets.push({
        no: k + 1,
        weight: rec ? rec.weight : weight,
        reps: rec ? rec.reps : cur.reps,
        unit: pick.unit,
        done: !!rec,
        pr: false
      });
    }

    this.maxBefore = db.maxWeightBefore(pick.id, this.date);

    const originCn = cur.swapped ? cur.originCn : cur.cn;
    const newItem = {
      exId: pick.id,
      cn: pick.cn,
      en: pick.en,
      part: pick.part,
      slot: slot,
      sets: n,
      reps: cur.reps,
      weight: weight,
      unit: pick.unit,
      swapped: !!originCn && originCn !== pick.cn,
      originCn: originCn
    };
    this.plan.items[i] = newItem;

    let lastText = '第一次做这个动作';
    let sugHint = '';
    if (sug.reason === 'up') {
      lastText = '上次 ' + sug.prev + ' kg × ' + cur.reps + ' × ' + sug.sets + ' 组';
      sugHint = '全部完成，今天加 ' + sug.step + ' kg';
    } else if (sug.reason === 'keep') {
      lastText = '上次 ' + sug.prev + ' kg × ' + cur.reps + ' × ' + sug.sets + ' 组';
      sugHint = sug.enoughSets ? '上次没做满，今天保持' : '上次只做了 ' + sug.sets + ' 组，今天保持';
    } else if (pick.unit !== 'kg') {
      lastText = describeLast(db.lastRecord(pick.id, this.date), pick.unit) || '第一次做这个动作';
    }

    this.setData({
      ex: newItem,
      sets: sets,
      lastText: lastText,
      sugHint: sugHint
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
