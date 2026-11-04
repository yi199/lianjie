const CAT = require('../../utils/catalog');
const EX = require('../../data/exercises');

const PLACE_CN = { gym: '健身房', home: '家里' };
const UNIT_CN = { kg: '按重量记', bw: '按次数记', sec: '按秒数记' };

/** 「怎么记」一句话：单位决定记法，文案跟训练页的实际输入保持一致 */
function howtoText(ex) {
  if (ex.unit === 'sec') return '这个动作按秒数记：做完一组，填这组撑了多少秒。';
  if (ex.unit === 'bw') return '自重动作按次数记：一组做几下就填几下。加不上重量就加次数。';
  return '按重量记：填这组用的重量和次数，下次会照上次的表现给建议。';
}

Page({
  data: {
    sbh: 20,
    id: '',
    ex: {},
    partCn: '',
    placeCn: '',
    unitCn: '',
    howto: '',
    steps: [],
    imgUrl: '',
    loading: true,
    failed: false,
    custom: false
  },

  onLoad(opts) {
    this.backTimer = null;
    const app = getApp();
    this.setData({ sbh: app.globalData.statusBarHeight });

    const id = (opts && opts.id) ? String(opts.id) : '';
    const ex = CAT.find(id);

    // 骨架先上：标题、要点、记录方式都是本地字段，断网也能看
    if (!ex) {
      wx.showToast({ title: '没找到这个动作', icon: 'none' });
      this.backTimer = setTimeout(function () { wx.navigateBack(); }, 700);
      return;
    }

    this.setData({
      id: id,
      ex: ex,
      partCn: EX.PART_CN[ex.part] || ex.part || '',
      placeCn: PLACE_CN[ex.place] || '',
      unitCn: UNIT_CN[ex.unit] || '',
      howto: howtoText(ex),
      custom: !!ex.custom
    });

    // 自建动作没有讲解和插画（服务端也没有这条），不必打后端
    if (ex.custom) {
      this.setData({ loading: false });
      return;
    }

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

  /** 拉 steps + imgDetail：缓存命中直接回来，失败就退成「讲解还没补上」 */
  fetch() {
    const self = this;
    this.setData({ loading: true, failed: false });
    CAT.detail(this.data.id).then(function (rec) {
      if (!rec) {
        self.setData({ loading: false, failed: true });
        return;
      }
      self.setData({
        loading: false,
        failed: false,
        imgUrl: rec.imgDetail || '',
        steps: (rec.steps || []).map(function (t, i) {
          return { i: i, no: ('0' + (i + 1)).slice(-2), text: t };
        })
      });
    });
  },

  retry() {
    this.fetch();
  },

  /** 图挂了就当没图，别留一个破图框 */
  onImgError() {
    this.setData({ imgUrl: '' });
  },

  back() {
    wx.navigateBack();
  }
});
