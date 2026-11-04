const db = require('../../utils/db');
const EX = require('../../data/exercises');      // PART_CN / 静态名表
const CAT = require('../../utils/catalog');      // 动作查表统一走它（官方清单 + 自建动作）

const PARTS = [
  { key: 'all', name: '全部' },
  { key: 'chest', name: '胸' },
  { key: 'back', name: '背' },
  { key: 'shoulders', name: '肩' },
  { key: 'arms', name: '手臂' },
  { key: 'legs', name: '腿' },
  { key: 'core', name: '核心' }
];

/** 训练日里的 exIds → 带中文名的展示结构 */
function hydrate(sessions) {
  return sessions.map(function (s, i) {
    const letter = String.fromCharCode(65 + i);
    const exIds = (s.exIds || []).slice();
    return {
      key: letter,
      name: s.name || ('训练日 ' + letter),
      exIds: exIds,
      exs: exIds.map(function (id) {
        const ex = CAT.find(id) || { cn: id, en: '', part: '' };
        return {
          id: id,
          cn: ex.cn,
          en: ex.en,
          unitCn: ex.unit === 'sec' ? '计时' : (ex.unit === 'bw' ? '自重' : 'kg'),
          partCn: EX.PART_CN[ex.part] || ''
        };
      })
    };
  });
}

function emptyDay(i) {
  const letter = String.fromCharCode(65 + i);
  return { key: letter, name: '训练日 ' + letter, exIds: [] };
}

Page({
  data: {
    sbh: 20,
    enter: false,
    id: '',
    name: '我的方案',
    place: 'gym',
    level: 'some',
    days: 2,
    sessions: [],

    /* 选动作抽屉 */
    sheetOpen: false,
    sheetDay: 0,
    sheetDayName: '',
    sheetPart: 'all',
    sheetList: [],
    sheetCount: 0,
    parts: PARTS
  },

  onLoad(options) {
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });

    if (options && options.id) {
      const prog = db.customPrograms().filter(function (x) { return x.id === options.id; })[0];
      if (prog) {
        this.setData({
          id: prog.id,
          name: prog.name,
          place: prog.place,
          level: prog.level,
          days: prog.days,
          sessions: hydrate(prog.sessions)
        });
        return;
      }
    }

    // 新建：默认给两个空训练日
    const init = [];
    for (let i = 0; i < 2; i++) init.push(emptyDay(i));
    this.setData({ sessions: hydrate(init), days: 2 });
  },

  onReady() {
    const self = this;
    this.setData({ enter: false });
    setTimeout(function () { self.setData({ enter: true }); }, 24);
  },

  onName(e) {
    this.setData({ name: e.detail.value });
  },

  /* ---------------- 场所 / 水平 / 天数 ---------------- */

  setPlace(e) {
    const place = e.currentTarget.dataset.v;
    if (place === this.data.place) return;

    const hasEx = this.data.sessions.some(function (s) { return s.exIds.length; });
    const self = this;
    const label = place === 'home' ? '居家' : '健身房';

    if (hasEx) {
      wx.showModal({
        title: '换成' + label + '？',
        content: '现在选的动作都属于' + (this.data.place === 'home' ? '居家' : '健身房') +
          '，换场所后会被清空，得重新选。',
        confirmText: '换',
        confirmColor: '#B4795A',
        success(res) {
          if (!res.confirm) return;
          self.applyPlace(place, true);
        }
      });
      return;
    }
    this.applyPlace(place, false);
  },

  applyPlace(place, clear) {
    const sessions = this.data.sessions.map(function (s) {
      return { name: s.name, exIds: clear ? [] : s.exIds };
    });
    this.setData({ place: place, sessions: hydrate(sessions) });
    if (clear) wx.showToast({ title: '已清空动作', icon: 'none' });
  },

  setLevel(e) {
    this.setData({ level: e.currentTarget.dataset.v });
  },

  setDays(e) {
    const n = Number(e.currentTarget.dataset.v);
    if (n === this.data.days) return;

    const cur = this.data.sessions;
    const next = [];
    for (let i = 0; i < n; i++) {
      next.push(cur[i] ? { name: cur[i].name, exIds: cur[i].exIds } : emptyDay(i));
    }
    this.setData({ days: n, sessions: hydrate(next) });
  },

  /* ---------------- 抽屉：挑动作 ---------------- */

  openSheet(e) {
    const i = Number(e.currentTarget.dataset.i);
    this.setData({
      sheetOpen: true,
      sheetDay: i,
      sheetDayName: this.data.sessions[i].name,
      sheetPart: 'all'
    });
    this.refreshSheet();
  },

  closeSheet() {
    this.setData({ sheetOpen: false });
  },

  setSheetPart(e) {
    this.setData({ sheetPart: e.currentTarget.dataset.v });
    this.refreshSheet();
  },

  /** 按场所 + 部位过滤，并标出「这一天的动作里已经有了」 */
  refreshSheet() {
    const place = this.data.place;
    const part = this.data.sheetPart;
    const picked = this.data.sessions[this.data.sheetDay].exIds;

    // 自建动作置顶、不吃场所过滤（它可能两处都能做）；官方按场所 + 部位筛
    const mine = CAT.custom().filter(function (ex) {
      return part === 'all' || ex.part === part;
    });
    const official = CAT.list().filter(function (ex) {
      if (ex.place !== place) return false;
      if (part !== 'all' && ex.part !== part) return false;
      return true;
    });
    const list = mine.concat(official).map(function (ex) {
      return {
        id: ex.id,
        cn: ex.cn,
        en: ex.en,
        partCn: EX.PART_CN[ex.part] || '',
        unitCn: ex.unit === 'sec' ? '计时' : (ex.unit === 'bw' ? '自重' : 'kg'),
        picked: picked.indexOf(ex.id) >= 0
      };
    });

    this.setData({ sheetList: list, sheetCount: picked.length });
  },

  toggleEx(e) {
    const id = e.currentTarget.dataset.id;
    const i = this.data.sheetDay;
    const sessions = this.data.sessions.map(function (s) {
      return { name: s.name, exIds: s.exIds.slice() };
    });
    const exIds = sessions[i].exIds;
    const k = exIds.indexOf(id);

    if (k >= 0) {
      exIds.splice(k, 1);
    } else {
      if (exIds.length >= 8) {
        wx.showToast({ title: '一个训练日最多 8 个动作', icon: 'none' });
        return;
      }
      exIds.push(id);
    }

    this.setData({ sessions: hydrate(sessions) });
    this.refreshSheet();
  },

  /** 在训练日卡片上直接移除某个动作 */
  removeEx(e) {
    const i = Number(e.currentTarget.dataset.i);
    const id = e.currentTarget.dataset.id;
    const sessions = this.data.sessions.map(function (s) {
      return { name: s.name, exIds: s.exIds.filter(function (x) { return x !== id; }) };
    });
    this.setData({ sessions: hydrate(sessions) });
  },

  /* ---------------- 保存 ---------------- */

  save() {
    const name = (this.data.name || '').trim();
    if (!name) {
      wx.showToast({ title: '给方案起个名字', icon: 'none' });
      return;
    }

    const filled = this.data.sessions.filter(function (s) { return s.exIds.length; });
    if (!filled.length) {
      wx.showToast({ title: '至少给一个训练日加动作', icon: 'none' });
      return;
    }

    const empty = this.data.sessions.length - filled.length;

    const self = this;
    const doSave = function () {
      const row = db.saveCustomProgram({
        id: self.data.id,
        name: name,
        place: self.data.place,
        level: self.data.level,
        sessions: filled.map(function (s) { return { name: s.name, exIds: s.exIds }; })
      });
      db.activateProgram(row.id);
      wx.showToast({ title: '已保存并启用', icon: 'none' });
      setTimeout(function () {
        wx.navigateBack();
      }, 620);
    };

    if (empty > 0) {
      wx.showModal({
        title: '有 ' + empty + ' 个训练日没动作',
        content: '空的训练日会被跳过，方案里只保留填了动作的 ' + filled.length + ' 天。',
        confirmText: '保存',
        confirmColor: '#3C4A32',
        success(res) {
          if (res.confirm) doSave();
        }
      });
      return;
    }

    doSave();
  }
});
