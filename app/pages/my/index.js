const db = require('../../utils/db');
const sync = require('../../utils/sync');
const diag = require('../../utils/diag');

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
 * 同步 / 存储状态这一行要回答三个问题：开着没有、传完没有、上次什么时候。
 *
 * 产品定位是「轻量 · 无需登录」，所以纯本地时这里**只说事实、不给动作**：
 * 「数据保存在这台手机上」+ 一句去哪儿备份。绝不说「云端 / 服务端 / 队列」，
 * 也不做「点一下同步」的按钮 —— 同步本来就是全自动的，按钮只会让人以为不点就不传。
 */
function syncView() {
  const st = sync.status();

  if (!st.enabled) {
    return {
      state: 'local',
      title: '数据保存在这台手机上',
      sub: '换手机前用下面的「备份」带走，再用「恢复」放回来'
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
      wx.showToast({ title: '数据就在这台手机上，不用重试', icon: 'none' });
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

  gotoPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/index' });
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
    const online = sync.status().enabled;
    wx.showModal({
      title: '清空训练记录',
      content: '所有练过的组都会被删掉，计划设置保留。' + (online ? '其它设备上的记录也会一起清掉。' : ''),
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

  /**
   * 「备份与恢复」：两个低频动作收进一个入口，不在页面上各占一行。
   * 绝大多数人不会关心数据存在哪，把这件事摊在设置页第一屏只会变成噪音。
   */
  backupMenu() {
    const self = this;
    wx.showActionSheet({
      itemList: ['备份（复制一段文字）', '从备份恢复（粘贴那段文字）'],
      success(res) {
        if (res.tapIndex === 0) self.exportData();
        else if (res.tapIndex === 1) self.restoreData();
      },
      fail() { /* 用户取消 */ }
    });
  },

  /** 备份：整份数据打成 JSON 复制到剪贴板（纯本地生成，不发网络请求） */
  exportData() {
    let text = '';
    try {
      text = JSON.stringify(db.exportData(), null, 2);
    } catch (e) {
      wx.showToast({ title: '导出失败了，再试一次', icon: 'none' });
      return false;
    }
    wx.setClipboardData({
      data: text,
      success: function () { },     // 系统自带「内容已复制」提示，别再叠一个 toast
      fail: function () {
        wx.showToast({ title: '复制失败，再试一次', icon: 'none' });
      }
    });
    return true;
  },

  /**
   * 恢复：把剪贴板里的备份放回来。
   *
   * 这是「无需登录」路线换手机的唯一出路 —— 没有账号，数据就只能靠用户自己带走。
   * 先算账、再确认、后落地，而且**只加不删**：最坏情况是什么都没变，
   * 绝不会因为粘错一段 JSON 把本机记录搞丢。
   */
  restoreData() {
    const self = this;
    wx.getClipboardData({
      success(res) {
        const raw = (res && res.data) || '';
        if (!String(raw).trim()) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' });
          return;
        }

        const look = db.inspectImport(raw);
        if (!look.ok) {
          wx.showToast({ title: look.reason, icon: 'none', duration: 3000 });
          return;
        }
        if (!look.total) {
          wx.showToast({ title: '这段备份里没有新记录', icon: 'none' });
          return;
        }

        const parts = [];
        if (look.sets.added + look.sets.updated) {
          parts.push('训练记录 ' + (look.sets.added + look.sets.updated) + ' 组');
        }
        if (look.metrics.added + look.metrics.updated) {
          parts.push('身体指标 ' + (look.metrics.added + look.metrics.updated) + ' 条');
        }
        if (look.exercises.added + look.exercises.updated) {
          parts.push('自建动作 ' + (look.exercises.added + look.exercises.updated) + ' 个');
        }
        const skip = look.badRows ? '，另有 ' + look.badRows + ' 行看不懂会跳过' : '';

        wx.showModal({
          title: '恢复备份',
          content: '将恢复 ' + parts.join(' · ') + skip + '。手机上已有的记录不会丢，同一条以较新的为准。',
          confirmText: '恢复',
          success(r) {
            if (!r.confirm) return;
            const out = db.applyImport(raw);
            if (!out.ok) {
              wx.showToast({ title: out.reason || '恢复失败了', icon: 'none' });
              return;
            }
            wx.showToast({
              title: '已恢复 ' + (out.sets.added + out.sets.updated) + ' 组',
              icon: 'none'
            });
            self.refresh();
          }
        });
      },
      fail() {
        wx.showToast({ title: '读不到剪贴板', icon: 'none' });
      }
    });
  },

  /** 诊断信息：本地错误日志 + 数据量，一键复制（纯本地模式也能报障） */
  diagInfo() {
    let extra = [];
    try {
      const t = db.allTimeStats();
      extra = ['本机数据：' + (t.days || 0) + ' 天 · ' + (t.totalSets || 0) + ' 组 · 自建动作 ' +
        (db.customExercises() || []).length + ' 个'];
    } catch (e) { /* 数据读不出来也要能复制 */ }

    wx.setClipboardData({
      data: diag.text(extra),
      success: function () { },
      fail: function () { wx.showToast({ title: '复制失败，再试一次', icon: 'none' }); }
    });
  },

  /**
   * 删除我的全部数据（合规要求的「删除个人信息」）。
   *
   * 这是全项目唯一不可撤销的操作，所以文案必须说清「删了就没了」，
   * 不能写成「清空数据」那种听着还能补回来的说法。
   * 用户可见文案里不出现「账号 / 云端 / 服务端」这些词 —— 这是轻量工具的定位。
   */
  deleteAccount() {
    const online = sync.status().enabled;
    wx.showModal({
      title: '删除我的全部数据',
      content: online
        ? '这台手机和你其它设备上的训练记录、身体指标、自建动作会被全部删掉，删了就找不回来了。'
        : '这台手机上的训练记录、身体指标、自建动作会被全部删掉，删了就找不回来了。',
      confirmText: '删除',
      confirmColor: '#B4795A',
      success(res) {
        if (!res.confirm) return;

        const finish = function () {
          db.resetAll();
          wx.reLaunch({ url: '/pages/welcome/index' });
        };

        // 没连云端：本地清空就是完整的「删除个人信息」，不需要任何账号动作
        if (!online) {
          finish();
          return;
        }

        wx.showLoading({ title: '正在删除', mask: true });
        sync.deleteAccount().then(function () {
          wx.hideLoading();
          finish();
        }).catch(function () {
          // 线上没删掉就别清本地：否则用户以为删了，下次同步又被拉回来
          wx.hideLoading();
          wx.showToast({ title: '没删成功，稍后再试', icon: 'none' });
        });
      }
    });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
