const db = require('../../utils/db');
const sync = require('../../utils/sync');

/** 「上次同步」说人话：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 */
function agoText(iso) {
  if (!iso) return '还没同步过';
  const t = Date.parse(iso);
  if (!t) return '还没同步过';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 45) return '刚刚';
  if (sec < 3600) return Math.round(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.round(sec / 3600) + ' 小时前';
  return Math.round(sec / 86400) + ' 天前';
}

/**
 * 同步这一栏要回答三个问题：开没开、传完没有、上次什么时候。
 * 以前这些只在 console 里，用户看不出记录到底上云了没有。
 */
function syncView() {
  const st = sync.status();

  if (!st.enabled) {
    return {
      state: 'local',
      title: '本地模式',
      sub: '没接后端，数据只在这台手机上，换设备拉不回来'
    };
  }

  if (st.running) {
    return {
      state: 'busy',
      title: '正在同步…',
      sub: st.pending > 0 ? '待上传 ' + st.pending + ' 条' : '正在上传'
    };
  }

  if (st.lastError) {
    const wait = st.retryDelay ? Math.round(st.retryDelay / 1000) + ' 秒后自动重试' : '稍后自动重试';
    return {
      state: 'error',
      title: '这次没传上去',
      sub: '待上传 ' + st.pending + ' 条 · ' + wait + ' · 点一下立即重试'
    };
  }

  if (st.pending > 0) {
    return {
      state: 'wait',
      title: '待上传 ' + st.pending + ' 条',
      sub: '上次同步 ' + agoText(st.lastSyncAt) + ' · 点一下立即同步'
    };
  }

  return {
    state: 'ok',
    title: '已同步',
    sub: '上次同步 ' + agoText(st.lastSyncAt) + ' · 点一下再对一次'
  };
}

Page({
  data: {
    sbh: 20,
    profile: { days: 3, place: 'gym', level: 'some' },
    profileText: '',
    planKeys: [],
    thisYear: 2026,
    birthValue: '1995-01-01',
    hasAny: false,
    syncState: 'local',
    syncTitle: '本地模式',
    syncSub: '',
    enter: false
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });
  },

  onShow() {
    // 自定义 tabBar：页面得主动告诉它当前选中的是第几个
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }

    if (!db.hasOnboarded()) {
      wx.reLaunch({ url: '/pages/welcome/index' });
      return;
    }
    this.refresh();
    this.playEnter();
  },

  playEnter() {
    const self = this;
    this.setData({ enter: false });
    setTimeout(function () { self.setData({ enter: true }); }, 24);
  },

  refresh() {
    const p = db.profile() || { days: 3, place: 'gym', level: 'some' };
    const keys = db.plans().map(function (x) {
      return { key: x.key, name: x.name };
    });
    const sv = syncView();
    const thisYear = new Date().getFullYear();
    this.setData({
      profile: p,
      thisYear: thisYear,
      birthValue: (Number(p.birthYear) || 1995) + '-01-01',
      profileText: db.profileText(),
      planKeys: keys,
      hasAny: db.hasAnyRecord(),
      syncState: sv.state,
      syncTitle: sv.title,
      syncSub: sv.sub
    });
  },

  /**
   * 改任何一项都会重新生成计划，已有的训练记录保留。
   *
   * 手动调参数 = 要「按参数自动排」，所以顺手把 programId 清成 auto：
   * 否则正在用某个方案时，这里改天数/场所/水平根本不会生效。
   */
  apply(patch) {
    const p = Object.assign({}, this.data.profile, patch, { programId: 'auto' });
    db.saveProfile(p);
    this.refresh();
    wx.showToast({ title: '已按参数重排', icon: 'none' });
  },

  /** 点同步这一栏：本地模式说实话，接了后端就立刻推一轮 */
  tapSync() {
    const st = sync.status();
    if (!st.enabled) {
      wx.showToast({ title: '本地模式：没接后端', icon: 'none' });
      return;
    }
    sync.kick();
    wx.showToast({ title: '正在同步…', icon: 'none' });
    const self = this;
    setTimeout(function () { self.refresh(); }, 900);
  },

  /**
   * 只改个人资料（性别 / 出生年）：不重排计划、不弹「已按参数重排」。
   * 这两项只服务「力量水平」评级，和训练日队列没关系。
   */
  setField(patch) {
    const p = Object.assign({}, this.data.profile, patch);
    db.saveProfile(p);
    this.refresh();
  },

  setSex(e) {
    this.setField({ sex: e.currentTarget.dataset.v || '' });
  },

  setBirth(e) {
    const y = String((e.detail && e.detail.value) || '').slice(0, 4);
    this.setField({ birthYear: Number(y) || 0 });
  },

  gotoPrograms() {
    wx.navigateTo({ url: '/pages/programs/index' });
  },

  gotoMetrics() {
    wx.navigateTo({ url: '/pages/metrics/index' });
  },

  gotoMyExercises() {
    wx.navigateTo({ url: '/pages/my-exercises/index' });
  },

  setDays(e) {
    this.apply({ days: Number(e.currentTarget.dataset.v) });
  },

  setPlace(e) {
    this.apply({ place: e.currentTarget.dataset.v });
  },

  setLevel(e) {
    this.apply({ level: e.currentTarget.dataset.v });
  },

  fillDemo() {
    const n = db.loadDemo();
    if (n < 0) {
      // -1 = 已经有训练记录了，示例数据不许覆盖真实数据
      wx.showToast({ title: '已经有训练记录了，示例不会覆盖', icon: 'none' });
      return;
    }
    if (!n) {
      wx.showToast({ title: '还没有计划', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已填入 ' + n + ' 条示例', icon: 'none' });
    this.refresh();
  },

  clearData() {
    const self = this;
    wx.showModal({
      title: '清空训练记录',
      content: '所有练过的组都会被删掉，计划设置保留。接后端时，其他设备上的记录也会一起清掉。',
      confirmText: '清空',
      confirmColor: '#B4795A',
      success(res) {
        if (!res.confirm) return;
        db.clearSets();
        wx.showToast({ title: '已清空', icon: 'none' });
        self.refresh();
      }
    });
  },

  restart() {
    const self = this;
    wx.showModal({
      title: '重新引导',
      content: '只清本机的计划设置和训练记录。若已接后端，重新登录后服务端的历史记录会自动拉回。',
      confirmText: '重新开始',
      confirmColor: '#B4795A',
      success(res) {
        if (!res.confirm) return;
        db.resetAll();
        wx.reLaunch({ url: '/pages/welcome/index' });
      }
    });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
