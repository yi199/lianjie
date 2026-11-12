const db = require('../../utils/db');
const kit = require('../../utils/tabkit');
const enterFx = require('../../utils/enter').enterFx;

Page({
  data: {
    sbh: 20,
    enter: false,
    auto: true,
    profileText: '',
    planKeys: [],
    official: [],
    custom: [],
    expanded: '',
    expandedSessions: [],
    expandedName: ''
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });
  },

  onShow() {
    if (!db.hasOnboarded()) {
      wx.reLaunch({ url: '/pages/welcome/index' });
      return;
    }
    // 从编辑页返回时可能刚存了新方案，这里每次重读
    this.refresh();
    this.playEnter();
  },

  playEnter() {
    enterFx(this);      // 详情页：内容从右侧推进来（见 utils/enter.js）
  },

  refresh() {
    const list = db.programList();
    this.setData({
      auto: list.auto,
      profileText: db.profileText(),
      planKeys: db.plans().map(function (p) { return { key: p.key, name: p.name }; }),
      official: list.official,
      custom: list.custom
    });
  },

  /** 展开 / 收起「这个方案到底练什么」 */
  toggleExpand(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.expanded === id) {
      this.setData({ expanded: '', expandedSessions: [], expandedName: '' });
      return;
    }
    const sessions = db.programSessions(id);
    this.setData({ expanded: id, expandedSessions: sessions, expandedName: '' });
  },

  useProgram(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    // dataset 里的布尔在不同基础库类型不一致（true / 'true'），别拿它判断，直接查列表
    const hit = this.data.official.concat(this.data.custom).filter(function (x) { return x.id === id; })[0];

    if (hit && hit.active) {
      wx.showToast({ title: '已经在用这个方案', icon: 'none' });
      return;
    }

    const self = this;
    wx.showModal({
      title: '换成「' + name + '」？',
      content: '今天的训练安排会按新方案走。已经练过的记录都保留，不会被删。',
      confirmText: '用它',
      confirmColor: '#3C4A32',
      success(res) {
        if (!res.confirm) return;
        const prog = db.activateProgram(id);
        if (!prog) {
          wx.showToast({ title: '方案不存在了', icon: 'none' });
          return;
        }
        self.setData({ expanded: '', expandedSessions: [] });
        self.refresh();
        wx.showToast({ title: '已换成 ' + prog.name, icon: 'none' });
      }
    });
  },

  /** 退回「按参数自动排」 */
  useAuto() {
    if (this.data.auto) return;
    const self = this;
    wx.showModal({
      title: '退回自动排？',
      content: '不再用具体方案，按「一周几次 × 在哪练 × 水平」机械地排训练日。',
      confirmText: '退回',
      confirmColor: '#3C4A32',
      success(res) {
        if (!res.confirm) return;
        db.activateProgram('auto');
        self.setData({ expanded: '', expandedSessions: [] });
        self.refresh();
        wx.showToast({ title: '已退回自动排', icon: 'none' });
      }
    });
  },

  newProgram() {
    wx.navigateTo({ url: '/pages/builder/index' });
  },

  editCustom(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/builder/index?id=' + id });
  },

  removeCustom(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const self = this;
    wx.showModal({
      title: '删掉「' + name + '」？',
      content: '只删这个方案。如果正在用它，会自动退回按参数排；训练记录不受影响。',
      confirmText: '删除',
      confirmColor: '#B4795A',
      success(res) {
        if (!res.confirm) return;
        db.removeCustomProgram(id);
        self.setData({ expanded: '', expandedSessions: [] });
        self.refresh();
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },

  gotoToday() {
    kit.backToShell(0);
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
