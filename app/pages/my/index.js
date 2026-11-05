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
 *
 * 同步本来就是全自动的（改完 2 秒防抖上传 + 失败指数退避 + 空闲轮询），
 * 所以这一栏默认只是「显示」：点它没有任何用，也不要暗示「不点就不传」。
 * 只有失败态才给一个「重试」——那才是真的需要人来催一脚的场合。
 */
function syncView() {
  const st = sync.status();

  if (!st.enabled) {
    return {
      state: 'local',
      title: '本地模式',
      sub: '还没连上云端，数据只在这台手机上，换手机会丢'
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
      sub: '待上传 ' + st.pending + ' 条 · ' + wait
    };
  }

  if (st.pending > 0) {
    return {
      state: 'wait',
      title: '待上传 ' + st.pending + ' 条',
      sub: '上次同步 ' + agoText(st.lastSyncAt) + ' · 会自动传上去'
    };
  }

  return {
    state: 'ok',
    title: '已同步',
    sub: '上次同步 ' + agoText(st.lastSyncAt)
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
    this.startSyncTick();
    this.playEnter();
  },

  onHide() {
    this.stopSyncTick();
  },

  onUnload() {
    this.stopSyncTick();
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

  /**
   * 只有「没传上去」的时候这一栏才可点：手动催一轮。
   * 其它状态点它什么都不做 —— 自动会传，别让用户以为要靠他按。
   * @returns {boolean} 是否真的重试了（测试用）
   */
  tapSync() {
    const st = sync.status();
    if (!st.enabled) {
      wx.showToast({ title: '本地模式：还没连上云端', icon: 'none' });
      return false;
    }
    if (!st.lastError) return false;
    sync.kick();
    wx.showToast({ title: '正在重试…', icon: 'none' });
    const self = this;
    setTimeout(function () { self.refreshSync(); }, 600);
    return true;
  },

  /** 只刷新同步那一栏（3 秒轮询用它，别整页重算） */
  refreshSync() {
    const sv = syncView();
    if (sv.state === this.data.syncState && sv.title === this.data.syncTitle && sv.sub === this.data.syncSub) return;
    this.setData({ syncState: sv.state, syncTitle: sv.title, syncSub: sv.sub });
  },

  /** 页面可见时才轮询：状态自己会走到「已同步」，用户不用盯着 */
  startSyncTick() {
    this.stopSyncTick();
    if (!sync.status().enabled) return;      // 本地模式没有会变的状态，别空转
    const self = this;
    this.syncTimer = setInterval(function () { self.refreshSync(); }, 3000);
  },

  stopSyncTick() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
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
