const db = require('../../utils/db');
const D = require('../../utils/date');

/** 训练日类型 → 卡片主视觉线稿 */
const ART = {
  push: 'press',
  pull: 'pull',
  legs: 'squat',
  upperA: 'press',
  upperB: 'pull',
  lowerA: 'squat',
  lowerB: 'squat',
  fullA: 'barbell',
  fullB: 'pull'
};

Page({
  data: {
    sbh: 20,
    weekday: '',
    dateText: '',
    h1: '',
    plan: null,
    items: [],
    doneCount: 0,
    lastText: '',
    finished: false,
    resumed: false,
    allDone: false,
    minutes: 0,
    tip: '',
    weekDone: 0,
    weekTarget: 0,
    weekDots: [],
    profileText: '',
    enter: false,
    art: ''
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });
  },

  onShow() {
    db.migrate();       // 从旧版本升级上来的，先修好存储格式
    if (!db.hasOnboarded()) {
      wx.reLaunch({ url: '/pages/welcome/index' });
      return;
    }
    this.refresh();
    this.playEnter();
  },

  /**
   * 切 tab / 从子页返回时，内容淡入一下。
   * switchTab 本身没有转场动画，只能靠内容层补。
   */
  playEnter() {
    const self = this;
    this.setData({ enter: false });
    setTimeout(function () { self.setData({ enter: true }); }, 24);
  },

  refresh() {
    const s = db.todaySession();
    const todaySets = db.todaySets() || [];

    const doneEx = {};
    todaySets.forEach(function (x) { doneEx[x.exId] = true; });

    const plan = s.plan;
    const items = plan
      ? plan.items.map(function (it, i) {
          let label;
          if (it.unit === 'sec') label = it.sets + ' × ' + it.reps + '″';
          else if (it.unit === 'bw') label = it.sets + ' × ' + it.reps + ' 次';
          else label = it.sets + ' × ' + it.reps;

          return Object.assign({}, it, {
            no: ('0' + (i + 1)).slice(-2),
            label: label,
            done: !!doneEx[it.exId]
          });
        })
      : [];

    const total = items.length;
    const hit = items.filter(function (x) { return x.done; }).length;
    const allDone = total > 0 && hit >= total;

    // 时长按组数估：一组连做带歇约 2.4 分钟，取到 5 分钟
    const setsTotal = items.reduce(function (a, it) { return a + (it.sets || 0); }, 0);
    const minutes = Math.max(20, Math.round(setsTotal * 2.4 / 5) * 5);

    let h1;
    if (!plan) {
      h1 = '还没有计划。';
    } else if (allDone) {
      h1 = '今天的' + plan.name + '练完了。';
    } else if (s.resumed) {
      h1 = '今天练了 ' + hit + '/' + total + ' 个动作。';
    } else if (s.finished) {
      h1 = '本周练完了。';
    } else {
      h1 = '今天练' + plan.name + '。';
    }

    let lastText = '';
    if (plan && plan.items.length) {
      const last = db.lastRecord(plan.items[0].exId);
      lastText = last
        ? '上次练这个 · ' + last.daysAgo + ' 天前'
        : '第一次练这个训练日';
    }

    let tip;
    if (allDone) {
      tip = '今天的动作都做完了。想再来一组也行，不想动就收工。';
    } else if (s.finished) {
      tip = '这周的目标已经完成。想再练一次也没问题，肌肉不嫌多。';
    } else if (s.resumed) {
      tip = '今天练了一半，接着练就行，已经勾掉的组都给你留着。';
    } else {
      tip = '今天没时间也没关系，第二天打开还是这个训练日，不会跳过。';
    }

    // 本周进度点
    const dots = [];
    for (let i = 0; i < s.week.target; i++) dots.push(i);

    this.setData({
      weekday: D.weekdayCN(),
      dateText: D.prettyDate(),
      h1: h1,
      plan: plan,
      items: items,
      doneCount: hit,
      allDone: allDone,
      minutes: minutes,
      tip: tip,
      lastText: lastText,
      finished: s.finished,
      resumed: s.resumed,
      weekDone: s.week.done,
      weekTarget: s.week.target,
      weekDots: dots,
      profileText: db.profileText(),
      art: plan ? (ART[plan.type] || 'barbell') : ''
    });
  },

  /** 底部主按钮：练完了就去看战报，否则继续练 */
  mainAction() {
    if (this.data.allDone) {
      wx.navigateTo({
        url: '/pages/report/index?date=' + D.today(),
        animationType: 'fade-in',
        animationDuration: 260
      });
      return;
    }
    wx.navigateTo({
      url: '/pages/record/index',
      animationType: 'fade-in',
      animationDuration: 240
    });
  },

  /** 点某个动作，直接跳到它 */
  openEx(e) {
    const i = e.currentTarget.dataset.i;
    wx.navigateTo({
      url: '/pages/record/index?i=' + i,
      animationType: 'fade-in',
      animationDuration: 240
    });
  },

  gotoStats() {
    wx.switchTab({ url: '/pages/stats/index' });
  },

  gotoMy() {
    wx.switchTab({ url: '/pages/my/index' });
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
});
