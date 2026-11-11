const CAT = require('../../utils/catalog');
const EX = require('../../data/exercises');
const META = require('../../data/exercise-meta');

const PLACE_CN = { gym: '健身房', home: '家里' };
const UNIT_CN = { kg: '按重量记', bw: '按次数记', sec: '按秒数记' };

Page({
  data: {
    sbh: 20,
    cpad: 102,      // 顶行右侧给胶囊让出的 px（app.js 里按真机几何算）
    id: '',
    ex: {},
    partCn: '',
    placeCn: '',
    unitCn: '',
    metaRows: [],      // 动作档案：难度 / 器材 / 主要肌群 / 单双侧 / 类型
    imgUrl: ''
  },

  onLoad(opts) {
    this.backTimer = null;
    const app = getApp();
    // cpad：英文小标贴右（margin-left:auto），得给右上角胶囊让位（见 app.js capsulePad）
    this.setData({ sbh: app.globalData.statusBarHeight, cpad: app.globalData.capsulePad || 102 });

    const id = (opts && opts.id) ? String(opts.id) : '';
    const ex = CAT.find(id);

    if (!ex) {
      wx.showToast({ title: '没找到这个动作', icon: 'none' });
      this.backTimer = setTimeout(function () { wx.navigateBack(); }, 700);
      return;
    }

    // 动作档案：表格里的展示列，本地就有，断网也能看
    const meta = META.get(id);
    const metaRows = meta ? [
      { k: '难度', v: meta.lv },
      { k: '器材', v: meta.gear },
      { k: '主要肌群', v: meta.muscles },
      { k: '单双侧', v: meta.sided },
      { k: '类型', v: meta.kind }
    ] : [];

    this.setData({
      id: id,
      ex: ex,
      partCn: EX.PART_CN[ex.part] || ex.part || '',
      placeCn: PLACE_CN[ex.place] || '',
      unitCn: UNIT_CN[ex.unit] || '',
      metaRows: metaRows
    });

    // 自建动作没有插画（服务端也没有这条），不必打后端
    if (ex.custom) return;

    this.fetch();
  },

  /**
   * 兜底返回的 timer 必须在卸载时清掉。
   * 否则用户自己先点了返回，700ms 后这个 timer 还会再退一层 ——
   * 多退一层，或者报 routeDone with a webviewId ... is not found。
   */
  onUnload() {
    if (this.backTimer) {
      clearTimeout(this.backTimer);
      this.backTimer = null;
    }
  },

  /** 整页只有插画要等后端；要点和动作档案都是本地字段，拉不到就静默不显示图 */
  fetch() {
    const self = this;
    CAT.detail(this.data.id).then(function (rec) {
      if (!rec || !rec.imgDetail) return;
      self.setData({ imgUrl: rec.imgDetail });
    });
  },

  /** 图挂了就收起，别留一个破图框 */
  onImgError() {
    this.setData({ imgUrl: '' });
  },

  back() {
    wx.navigateBack();
  }
});
