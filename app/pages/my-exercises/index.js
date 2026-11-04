const db = require('../../utils/db');

const PARTS = [
  { key: 'chest', name: '胸' },
  { key: 'back', name: '背' },
  { key: 'shoulders', name: '肩' },
  { key: 'arms', name: '手臂' },
  { key: 'legs', name: '腿' },
  { key: 'core', name: '核心' }
];
const PLACES = [{ key: 'gym', name: '健身房' }, { key: 'home', name: '家里' }];
const UNITS = [{ key: 'kg', name: '重量' }, { key: 'bw', name: '自重' }, { key: 'sec', name: '计时' }];

Page({
  data: {
    sbh: 20,
    list: [],
    canAdd: true,
    editing: null,          // null = 不在编辑态
    parts: PARTS,
    places: PLACES,
    units: UNITS,
    partCn: {},
    placeCn: { gym: '健身房', home: '家里' },
    unitCn: { kg: '重量', bw: '自重', sec: '计时' }
  },

  onLoad() {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });
    const partCn = {};
    PARTS.forEach(function (p) { partCn[p.key] = p.name; });
    this.setData({ partCn: partCn });
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const list = db.customExercises().map(function (e) {
      return {
        id: e.id, cn: e.cn, part: e.part, place: e.place, unit: e.unit,
        // tips 必须带上：不然点进编辑时表单是空的，一保存就把原来的要点冲掉
        tips: e.tips || '',
        // 被服务端拒绝过的行标红显示原因（§7.4：不能静默消失）
        syncError: e.syncError || ''
      };
    });
    this.setData({ list: list, canAdd: db.canAddCustomExercise() });
  },

  startNew() {
    if (!this.data.canAdd) {
      wx.showToast({ title: '最多 30 个自定义动作', icon: 'none' });
      return;
    }
    this.setData({
      editing: { exId: '', cn: '', part: 'chest', place: 'gym', unit: 'kg', tips: '' }
    });
  },

  startEdit(e) {
    const id = e.currentTarget.dataset.id;
    const row = this.data.list.filter(function (x) { return x.id === id; })[0];
    if (!row) return;
    this.setData({
      editing: {
        exId: row.id, cn: row.cn, part: row.part,
        place: row.place, unit: row.unit, tips: row.tips || ''
      }
    });
  },

  cancelEdit() {
    this.setData({ editing: null });
  },

  onName(e) {
    this.setData({ 'editing.cn': e.detail.value });
  },

  onTips(e) {
    this.setData({ 'editing.tips': e.detail.value });
  },

  /** 三个枚举都走同一个入口：data-field 决定改哪个 */
  pick(e) {
    const field = e.currentTarget.dataset.field;
    const v = e.currentTarget.dataset.v;
    const patch = {};
    patch['editing.' + field] = v;
    this.setData(patch);
  },

  save() {
    const ed = this.data.editing;
    if (!ed) return;
    if (!String(ed.cn || '').trim()) {
      wx.showToast({ title: '先起个名字', icon: 'none' });
      return;
    }
    db.saveCustomExercise(ed);
    this.setData({ editing: null });
    this.refresh();
    wx.showToast({ title: '已保存', icon: 'none' });
  },

  remove(e) {
    const id = e.currentTarget.dataset.id;
    const self = this;
    wx.showModal({
      title: '删除这个动作',
      content: '已经记过的训练不会消失。删除会同步到你的其它设备。',
      confirmText: '删除',
      confirmColor: '#B4795A',
      success(res) {
        if (!res.confirm) return;
        db.removeCustomExercise(id);
        self.refresh();
      }
    });
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  }
});
