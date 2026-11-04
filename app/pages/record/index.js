const db = require('../../utils/db');

const REST_SECONDS = 90;
const BREATH_CYCLE = 9;   // 吸 4 秒 + 呼 5 秒

/** 「上次 50 kg × 10 × 3 组」/「上次 12 次 × 3 组」/「上次 30 秒 × 3 组」 */
function describeLast(lr, unit) {
  if (!lr) return '';
  if (unit === 'sec') return '上次 ' + lr.reps + ' 秒 × ' + lr.sets + ' 组';
  if (unit === 'bw') return '上次 ' + lr.reps + ' 次 × ' + lr.sets + ' 组';
  return '上次 ' + lr.weight + ' kg × ' + lr.reps + ' × ' + lr.sets + ' 组';
}

/**
 * 杠铃上挂几片。
 * 片数代表重量（恒定，不带进度含义），颜色代表进度 —— 这样「这根杠铃被我练熟了」才有累积感。
 * 自重 / 计时动作没有重量，固定 3 片。
 */
function plateCountOf(weight, unit) {
  if (unit !== 'kg' || !(weight > 0)) return 3;
  return Math.min(5, Math.max(2, Math.round(weight / 6)));
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

    // 视觉层
    bigNum: 0,
    bigUnit: 'kg',
    leftPlates: [],
    rightPlates: [],
    setDots: [],
    targetText: '',
    volumeText: '—',
    hint: '',
    btnText: '完成这组',
    doneCount: 0,

    sets: [],
    resting: false,
    restText: '01:30',
    restPct: 100,
    restPhase: '吸气'
  },

  onLoad(opts) {
    const app = getApp();
    this.date = db.trainingDate();     // 跨零点：没练完的训练仍记在开始那天
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
    this.sugWeight = weight;            // 存进组记录的 targetWeight：当时建议的重量

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

    this.refreshView();
  },

  /* ---------- 视觉层：杠铃 / 大数字 / 组进度 / 信息表 / 按钮 ---------- */
  refreshView() {
    const ex = this.data.ex || {};
    const sets = this.data.sets || [];
    const total = sets.length || 1;
    const done = sets.filter(function (s) { return s.done; }).length;
    const first = sets[0] || { weight: 0, reps: 0, unit: 'kg' };

    // 大数字：负重看重量，自重看次数，计时看秒数
    let bigNum;
    let bigUnit;
    if (ex.unit === 'sec') { bigNum = first.reps; bigUnit = '秒'; }
    else if (ex.unit === 'bw') { bigNum = first.reps; bigUnit = '次'; }
    else { bigNum = first.weight || 0; bigUnit = 'kg'; }

    // 杠铃：片数代表重量（恒定），点亮的片数代表这组练到哪了
    const plateN = plateCountOf(first.weight, ex.unit);
    const lit = done === 0
      ? 0
      : (done >= total ? plateN : Math.max(1, Math.floor(done / total * plateN)));

    const isPR = ex.unit === 'kg' && first.weight > 0 && this.maxBefore > 0 && first.weight > this.maxBefore;

    const left = [];
    const right = [];
    for (let i = 0; i < plateN; i++) {
      const on = i < lit;
      const pr = on && isPR && i === lit - 1;
      left.push({ i: i, on: on, pr: pr });
      right.push({ i: i, on: on, pr: pr });
    }

    // 组进度点：一组一个点
    const dots = sets.map(function (s) {
      return { i: s.no, on: !!s.done, pr: !!(s.done && isPR) };
    });

    // 信息表
    const targetText = ex.sets + ' 组 × ' + ex.reps + (ex.unit === 'sec' ? ' 秒' : ' 次');
    const self = this;
    const todayRows = (db.todaySets(this.date) || []).filter(function (r) { return r.exId === ex.exId; });
    const volume = todayRows.reduce(function (a, r) { return a + (r.weight || 0) * (r.reps || 0); }, 0);
    const repsSum = todayRows.reduce(function (a, r) { return a + (r.reps || 0); }, 0);

    let volumeText = '—';
    if (todayRows.length) {
      if (ex.unit === 'kg') volumeText = volume > 0 ? volume + ' kg' : '—';
      else volumeText = repsSum + (ex.unit === 'sec' ? ' 秒' : ' 次');
    }

    // 底部按钮：还有没做的组就先做组，全做完才推进到下一个动作
    const pending = sets.filter(function (s) { return !s.done; })[0];
    let btnText;
    if (pending) {
      btnText = '完成第 ' + pending.no + ' 组 · ' + pending.reps + (ex.unit === 'sec' ? ' 秒' : ' 次');
    } else if (this.data.isLast) {
      btnText = '完成训练 · 看战报 →';
    } else {
      btnText = '下一个动作 →';
    }

    const hint = pending
      ? (done === 0 ? '点下方按钮完成一组 → 杠铃会一片片亮起来' : '还剩 ' + (total - done) + ' 组')
      : total + ' 组全部完成，重量已经留在你的记录里';

    self.setData({
      bigNum: bigNum,
      bigUnit: bigUnit,
      leftPlates: left,
      rightPlates: right,
      setDots: dots,
      doneCount: done,
      targetText: targetText,
      volumeText: volumeText,
      hint: hint,
      btnText: btnText
    });
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
    this.sugWeight = weight;

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
      tips: pick.tips || '',
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

    this.refreshView();
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
      // 取消勾选要落库：以前什么都不写，页面显示没做，统计和战报却还算着这一组
      db.uncheckSet({ date: this.date, exId: this.data.ex.exId, setNo: no });
      this.stopRest();
    }

    this.refreshView();
  },

  /**
   * 底部主按钮。
   * 一组之内不做任何动画和跳转，所以按钮只有一个动作：完成下一组。
   * 全部做完才推进到下一个动作 / 收尾战报。
   */
  mainAction() {
    const pending = (this.data.sets || []).filter(function (s) { return !s.done; })[0];
    if (pending) {
      this.completeSet(pending.no);
      return;
    }
    this.nextEx();
  },

  /** 把某一组标成完成（跟手动点勾走同一条路，保证落库一致） */
  completeSet(no) {
    let target = null;
    const sets = this.data.sets.map(function (s) {
      if (s.no === no && !s.done) {
        target = Object.assign({}, s, { done: true });
        return target;
      }
      return s;
    });
    if (!target) return;

    this.setData({ sets: sets });
    this.persist(target);
    this.startRest();
    try { wx.vibrateShort({ type: 'light' }); } catch (err) { /* 忽略 */ }
    this.refreshView();
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
    this.refreshView();
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
    this.refreshView();
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
      unit: row.unit,
      // 当时的位置和目标：以后判断「做满没有」拿这个比，换了方案也不变
      slot: this.data.ex.slot,
      targetWeight: this.data.ex.unit === 'kg' ? this.sugWeight : null,
      targetReps: this.data.ex.reps,
      targetSets: this.data.ex.sets
    });
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
      // 吸 4 秒、呼 5 秒，跟 CSS 的 9s 呼吸动画对齐
      const phase = (elapsed % BREATH_CYCLE) < 4 ? '吸气' : '呼气';

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

  /** 动作名旁边的「看讲解」→ 动作详情页（要点/步骤/插画都在那边） */
  gotoDetail() {
    const id = this.data.ex && this.data.ex.exId;
    if (!id) return;
    wx.navigateTo({ url: '/pages/exercise/index?id=' + encodeURIComponent(id) });
  },

  back() {
    wx.navigateBack({ animationType: 'fade-out', animationDuration: 200 });
  }
});
