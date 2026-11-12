/**
 * swiper 容器里的第 0 个 tab
 *
 * 业务逻辑一行没改，全部复用 pages/today/index.js 导出的配置（见 utils/tabkit.js）。
 * 这个文件只做两件事：
 *   1. 把页面配置转成组件配置
 *   2. 监听 active：成为当前 tab 时才跑一次原来的 onShow
 *      （三个 tab 同处一个页面，拿不到 pageLifetimes.show）
 */
const cfg = require('../../pages/today/index');
const kit = require('../../utils/tabkit');
const base = kit.asComponent(cfg);

Component({
  data: base.data,

  properties: {
    active: {
      type: Boolean,
      value: false,
      observer: function (on) {
        if (!on) return;
        const self = this;
        // 等这一帧渲染完再跑 onShow：数据页要量 canvas 尺寸，太早量到的是 0
        clearTimeout(this.__showTimer);
        this.__showTimer = setTimeout(function () { kit.callShow(cfg, self); }, 24);
      }
    }
  },

  lifetimes: Object.assign({}, base.lifetimes, {
    detached: function () {
      clearTimeout(this.__showTimer);
      const d = base.lifetimes && base.lifetimes.detached;
      if (typeof d === 'function') d.call(this);
    }
  }),

  methods: Object.assign({}, base.methods, {
    /** scroll-view 的下拉刷新：复用页面原来的 refresh() */
    onPull: function () {
      if (typeof this.refresh === 'function') this.refresh();
    }
  })
});
